/**
 * Cursor runtime adapter.
 *
 * Bridges Warden's runtime contract to the official @cursor/sdk so users
 * can drive analysis with Composer 2.5 (and other Cursor-hosted models)
 * via their existing Cursor subscription. The flow mirrors the Pi
 * adapter: Warden owns prompt construction, finding extraction, and
 * reporting; this module owns SDK session setup, streaming, telemetry,
 * and usage normalization.
 *
 * Notable shape differences from Pi/Claude that motivate the choices
 * below:
 *
 * - The Cursor SDK has no `systemPrompt` parameter. We prepend it to the
 *   user message with a clear delimiter so the model still sees both
 *   the framing and the task.
 *
 * - The SDK does not expose a tool allow/denylist. Warden's hunk
 *   analysis is read-only by contract, so we add a strong instruction
 *   in the prompt and emit a stderr warning when callers ask for
 *   anything Cursor cannot enforce. The fix gates and report
 *   pipeline assume the model only returns findings; they do not
 *   accept side effects from this runtime.
 *
 * - Per-call cost is not surfaced by the SDK. Token usage arrives via
 *   the `onDelta` callback's `turn-ended` updates; we normalize it
 *   into Warden's UsageStats with `costUSD: 0` (users see actual
 *   billing in the Cursor dashboard).
 */
import type { z } from 'zod';
import type { ToolConfig, ToolName } from '../../config/schema.js';
import { Sentry } from '../../sentry.js';
import type { UsageStats } from '../../types/index.js';
import { extractJson } from '../haiku.js';
import { isAuthenticationErrorMessage, sanitizeErrorMessage } from '../errors.js';
import {
  genAiProviderName,
  setGenAiInputMessagesAttr,
  setGenAiOutputMessagesAttr,
  setGenAiSystemInstructionsAttr,
  setGenAiUsageAttrs,
} from '../otel.js';
import { aggregateUsage, emptyUsage } from '../usage.js';
import type {
  AuxiliaryRunRequest,
  AuxiliaryRunResult,
  AuxiliaryTask,
  AuxiliaryTool,
  Runtime,
  SkillRunRequest,
  SkillRunResponse,
  SkillRunResult,
  SkillRunStatus,
  SynthesisRunRequest,
  SynthesisTask,
} from './types.js';

const DEFAULT_MODEL_ID = 'composer-2.5';
const READ_ONLY_TOOLS: ToolName[] = ['Read', 'Grep', 'Glob'];
const MUTATING_TOOLS: ToolName[] = ['Write', 'Edit', 'Bash'];
const UNSUPPORTED_TOOLS: ToolName[] = ['WebFetch', 'WebSearch'];

const READ_ONLY_INSTRUCTION =
  'You are running in Warden\'s read-only review mode. Do not call edit, write, delete, or shell tools that modify the workspace. Use only read, grep, glob, ls, and semantic-search tools.';

interface CursorModelSelection {
  id: string;
  params?: { id: string; value: string }[];
}

interface CursorUsageTokens {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

interface TurnEndedDelta {
  type: 'turn-ended';
  usage?: CursorUsageTokens;
}

interface InteractionUpdateLike {
  type?: string;
  usage?: CursorUsageTokens;
}

interface ToolCallEvent {
  type: 'tool_call';
  call_id: string;
  name: string;
  status: 'running' | 'completed' | 'error';
}

interface AssistantContentBlock {
  type: 'text' | 'tool_use';
  text?: string;
}

interface AssistantEvent {
  type: 'assistant';
  message: { content: AssistantContentBlock[] };
}

interface CursorRunHandle {
  id: string;
  status: 'running' | 'finished' | 'error' | 'cancelled';
  result?: string;
  durationMs?: number;
  stream(): AsyncGenerator<unknown, void>;
  wait(): Promise<{ status: string; result?: string; durationMs?: number }>;
  cancel(): Promise<void>;
}

interface CursorAgentHandle {
  agentId: string;
  send(message: string, options?: {
    model?: CursorModelSelection;
    onDelta?: (args: { update: InteractionUpdateLike }) => void;
  }): Promise<CursorRunHandle>;
  close(): void;
  [Symbol.asyncDispose](): Promise<void>;
}

interface CursorSdkModule {
  Agent: {
    create(options: unknown): Promise<unknown>;
  };
  Cursor?: unknown;
}

let cursorSdkPromise: Promise<CursorSdkModule> | undefined;

/**
 * Lazy import of @cursor/sdk. The SDK eagerly loads a native sqlite3
 * binding at module-load time, which breaks environments where the
 * binding hasn't been built (CI sandboxes, ncc bundles, tests). Deferring
 * the import to first call keeps `runtimes/index.ts` cheap.
 */
async function loadCursorSdk(): Promise<CursorSdkModule> {
  if (!cursorSdkPromise) {
    cursorSdkPromise = import('@cursor/sdk') as unknown as Promise<CursorSdkModule>;
  }
  return cursorSdkPromise;
}

/**
 * Test seam: replace the lazy SDK loader. Returns a restore function that
 * resets the loader to the real `@cursor/sdk` import.
 */
export function __setCursorSdkLoaderForTests(module: CursorSdkModule | undefined): () => void {
  const previous = cursorSdkPromise;
  cursorSdkPromise = module ? Promise.resolve(module) : undefined;
  return () => {
    cursorSdkPromise = previous;
  };
}

function errorMessage(error: unknown): string {
  return sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
}

/**
 * Parse a Warden config model string into a Cursor ModelSelection.
 *
 * Supports either a bare id ("composer-2.5") or a query-string suffix for
 * model parameters ("composer-2.5?thinking=high").
 */
export function parseCursorModelSelector(model: string | undefined): CursorModelSelection {
  if (!model) {
    return { id: DEFAULT_MODEL_ID };
  }
  const questionIndex = model.indexOf('?');
  if (questionIndex === -1) {
    return { id: model };
  }
  const id = model.slice(0, questionIndex);
  const paramString = model.slice(questionIndex + 1);
  const params: { id: string; value: string }[] = [];
  for (const pair of paramString.split('&')) {
    if (!pair) continue;
    const eqIndex = pair.indexOf('=');
    if (eqIndex === -1) continue;
    const key = decodeURIComponent(pair.slice(0, eqIndex));
    const value = decodeURIComponent(pair.slice(eqIndex + 1));
    if (key) {
      params.push({ id: key, value });
    }
  }
  return params.length > 0 ? { id, params } : { id };
}

/**
 * Resolve Warden's tool config into Cursor's read-only review constraints.
 * Cursor does not expose tool allow/denylists, so we emit warnings for any
 * tools we can't actually enforce and add a prompt-level instruction.
 */
export function resolveCursorSkillTools(
  tools: ToolConfig | undefined,
  allowMutatingTools = false,
): { warnings: string[]; readOnlyInstruction: string | undefined } {
  const denied = new Set(tools?.denied ?? []);
  const requested = tools?.allowed ?? READ_ONLY_TOOLS;
  const warnings: string[] = [];

  for (const tool of requested) {
    if (denied.has(tool)) continue;
    if (UNSUPPORTED_TOOLS.includes(tool)) {
      warnings.push(`Cursor runtime ignored unsupported tool: ${tool}`);
      continue;
    }
    if (!allowMutatingTools && MUTATING_TOOLS.includes(tool)) {
      warnings.push(`Cursor runtime ignored mutating tool without allowMutatingTools: ${tool}`);
    }
  }

  // Cursor cannot actually deny tool calls, so the only enforcement we
  // have is a prompt instruction. Skip it when the caller has opted into
  // mutating tools (trusted internal writer paths).
  const readOnlyInstruction = allowMutatingTools ? undefined : READ_ONLY_INSTRUCTION;
  return { warnings, readOnlyInstruction };
}

function composeUserPrompt(args: {
  systemPrompt: string;
  userPrompt: string;
  readOnlyInstruction?: string;
}): string {
  const sections = [
    `# System instructions`,
    args.systemPrompt,
    args.readOnlyInstruction ? `# Tool policy\n${args.readOnlyInstruction}` : undefined,
    `# Task`,
    args.userPrompt,
  ];
  return sections.filter((line): line is string => line !== undefined).join('\n\n');
}

function statusFromCursorStatus(status: string): SkillRunStatus {
  switch (status) {
    case 'finished':
      return 'success';
    case 'cancelled':
      return 'aborted';
    case 'error':
      return 'provider_error';
    default:
      return 'provider_error';
  }
}

function cursorUsageToStats(usage: CursorUsageTokens | undefined): UsageStats {
  if (!usage) {
    return emptyUsage();
  }
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  return {
    inputTokens: (usage.inputTokens ?? 0) + cacheRead + cacheWrite,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheWrite,
    cacheCreation5mInputTokens: cacheWrite,
    cacheCreation1hInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
  };
}

function getApiKey(explicit?: string): string | undefined {
  if (explicit) return explicit;
  return process.env['WARDEN_CURSOR_API_KEY'] ?? process.env['CURSOR_API_KEY'];
}

interface CursorRunOutcome {
  status: SkillRunStatus;
  text: string;
  errors: string[];
  usage: UsageStats;
  sessionId?: string;
  durationMs: number;
  numTurns: number;
  warnings: string[];
}

async function runCursorPrompt(args: {
  cwd?: string;
  systemPrompt: string;
  userPrompt: string;
  model: CursorModelSelection;
  apiKey: string;
  readOnlyInstruction?: string;
  abortController?: AbortController;
}): Promise<CursorRunOutcome> {
  const startedAt = Date.now();
  const turnUsages: UsageStats[] = [];
  let numTurns = 0;
  let assistantText = '';
  const errors: string[] = [];
  let agent: CursorAgentHandle | undefined;
  let activeRun: CursorRunHandle | undefined;
  let aborted = false;

  const onAbort = (): void => {
    aborted = true;
    if (activeRun) {
      void activeRun.cancel().catch(() => undefined);
    }
  };
  args.abortController?.signal.addEventListener('abort', onAbort, { once: true });

  try {
    if (args.abortController?.signal.aborted) {
      aborted = true;
    }

    const { Agent } = await loadCursorSdk();
    // The Cursor SDK types are loose at the boundary because pi-bundled
    // anysphere types don't resolve under skipLibCheck; cast at the edge.
    agent = (await Agent.create({
      apiKey: args.apiKey,
      model: args.model,
      local: { cwd: args.cwd ?? process.cwd() },
    })) as unknown as CursorAgentHandle;

    if (aborted) {
      return {
        status: 'aborted',
        text: '',
        errors: ['Aborted before send'],
        usage: emptyUsage(),
        sessionId: agent.agentId,
        durationMs: Date.now() - startedAt,
        numTurns: 0,
        warnings: [],
      };
    }

    const fullPrompt = composeUserPrompt({
      systemPrompt: args.systemPrompt,
      userPrompt: args.userPrompt,
      readOnlyInstruction: args.readOnlyInstruction,
    });

    activeRun = await agent.send(fullPrompt, {
      model: args.model,
      onDelta: ({ update }) => {
        const delta = update as InteractionUpdateLike;
        if (delta.type === 'turn-ended') {
          numTurns++;
          turnUsages.push(cursorUsageToStats((delta as TurnEndedDelta).usage));
        }
      },
    });

    for await (const event of activeRun.stream()) {
      if (!event || typeof event !== 'object') continue;
      const message = event as { type?: string };
      if (message.type === 'assistant') {
        const assistant = event as AssistantEvent;
        for (const block of assistant.message.content) {
          if (block.type === 'text' && block.text) {
            assistantText += block.text;
          }
        }
      } else if (message.type === 'tool_call') {
        const tool = event as ToolCallEvent;
        if (tool.status === 'error') {
          errors.push(`Tool ${tool.name} failed`);
        }
      } else if (message.type === 'status') {
        // Cloud-only lifecycle messages; surface error states only.
        const status = (event as { status?: string; message?: string });
        if (status.status === 'ERROR' && status.message) {
          errors.push(status.message);
        }
      }
    }

    const final = await activeRun.wait();
    const finalText = assistantText || final.result || '';
    const sdkStatus = aborted ? 'cancelled' : final.status;

    return {
      status: statusFromCursorStatus(sdkStatus),
      text: finalText,
      errors,
      usage: turnUsages.length > 0 ? aggregateUsage(turnUsages) : emptyUsage(),
      sessionId: agent.agentId,
      durationMs: final.durationMs ?? Date.now() - startedAt,
      numTurns: Math.max(numTurns, 1),
      warnings: [],
    };
  } finally {
    args.abortController?.signal.removeEventListener('abort', onAbort);
    if (agent) {
      try {
        await agent[Symbol.asyncDispose]();
      } catch {
        // Best-effort cleanup; the SDK handles transport teardown internally.
      }
    }
  }
}

function normalizeRunResult(outcome: CursorRunOutcome, model: CursorModelSelection): SkillRunResult {
  return {
    status: outcome.status,
    text: outcome.text,
    errors: outcome.errors,
    usage: outcome.usage,
    responseModel: model.id,
    sessionId: outcome.sessionId,
    durationMs: outcome.durationMs,
    numTurns: outcome.numTurns,
  };
}

function missingApiKeyResult<T>(kind: 'auxiliary' | 'synthesis'): AuxiliaryRunResult<T> {
  return {
    success: false,
    error: `Cursor API key required for ${kind} runtime. Set WARDEN_CURSOR_API_KEY or CURSOR_API_KEY.`,
    usage: emptyUsage(),
  };
}

async function runStructured<T>(
  request: {
    kind: 'auxiliary' | 'synthesis';
    task?: AuxiliaryTask | SynthesisTask;
    agentName?: string;
    apiKey?: string;
    prompt: string;
    schema: z.ZodType<T>;
    model?: string;
    tools?: AuxiliaryTool[];
    abortController?: AbortController;
  }
): Promise<AuxiliaryRunResult<T>> {
  const apiKey = getApiKey(request.apiKey);
  if (!apiKey) {
    return missingApiKeyResult(request.kind);
  }
  if (request.tools && request.tools.length > 0) {
    return {
      success: false,
      error: 'Cursor runtime does not support auxiliary tool callbacks',
      usage: emptyUsage(),
    };
  }

  const model = parseCursorModelSelector(request.model);
  const systemPrompt = [
    `You are Warden's ${request.kind} structured-output runtime.`,
    request.task ? `Task: ${request.task}` : undefined,
    'Return only valid JSON. Do not include markdown fences, commentary, or surrounding prose.',
  ].filter((line): line is string => line !== undefined).join('\n\n');

  return Sentry.startSpan(
    {
      op: 'gen_ai.chat',
      name: `chat ${model.id}`,
      attributes: {
        'gen_ai.operation.name': 'chat',
        'gen_ai.provider.name': genAiProviderName('cursor', model.id),
        ...(request.agentName ? { 'gen_ai.agent.name': request.agentName } : {}),
        ...(request.task ? { 'warden.ai.task': request.task } : {}),
        'gen_ai.request.model': model.id,
        'gen_ai.output.type': 'json',
      },
    },
    async (span) => {
      setGenAiSystemInstructionsAttr(span, systemPrompt);
      setGenAiInputMessagesAttr(span, [{ role: 'user', content: request.prompt }]);

      try {
        const outcome = await runCursorPrompt({
          systemPrompt,
          userPrompt: request.prompt,
          model,
          apiKey,
          abortController: request.abortController,
        });
        setGenAiUsageAttrs(span, outcome.usage);
        span.setAttribute('gen_ai.response.finish_reasons', [outcome.status]);
        if (outcome.text) {
          setGenAiOutputMessagesAttr(span, outcome.text, outcome.status);
        }

        if (outcome.status !== 'success') {
          span.setAttribute('error.type', outcome.status);
          return {
            success: false,
            error: outcome.errors.join('; ') || `Cursor runtime execution failed: ${outcome.status}`,
            usage: outcome.usage,
          };
        }

        const json = extractJson(outcome.text);
        if (!json) {
          span.setAttribute('error.type', 'invalid_json');
          return { success: false, error: 'No JSON found in Cursor response', usage: outcome.usage };
        }

        const parsed = JSON.parse(json);
        const validated = request.schema.safeParse(parsed);
        if (!validated.success) {
          span.setAttribute('error.type', 'validation_error');
          return { success: false, error: `Validation failed: ${validated.error.message}`, usage: outcome.usage };
        }

        return { success: true, data: validated.data, usage: outcome.usage };
      } catch (error) {
        span.setAttribute('error.type', error instanceof Error ? error.name : '_OTHER');
        return { success: false, error: errorMessage(error), usage: emptyUsage() };
      }
    },
  );
}

export const cursorRuntime: Runtime = {
  name: 'cursor',

  async runSkill(request: SkillRunRequest): Promise<SkillRunResponse> {
    const {
      systemPrompt,
      userPrompt,
      repoPath,
      apiKey: explicitApiKey,
      options,
      skillName,
      tools,
      allowMutatingTools,
    } = request;
    const { model: modelString, abortController } = options;
    const apiKey = getApiKey(explicitApiKey);
    const model = parseCursorModelSelector(modelString);
    const skillTools = resolveCursorSkillTools(tools, allowMutatingTools);

    if (!apiKey) {
      return {
        authError:
          'Cursor API key not found. Set WARDEN_CURSOR_API_KEY (preferred) or CURSOR_API_KEY.',
      };
    }

    return Sentry.startSpan(
      {
        op: 'gen_ai.invoke_agent',
        name: `invoke_agent ${skillName}`,
        attributes: {
          'gen_ai.operation.name': 'invoke_agent',
          'gen_ai.provider.name': genAiProviderName('cursor', model.id),
          'gen_ai.agent.name': skillName,
          'gen_ai.request.model': model.id,
        },
      },
      async (span) => {
        setGenAiSystemInstructionsAttr(span, systemPrompt);
        setGenAiInputMessagesAttr(span, [{ role: 'user', content: userPrompt }]);

        try {
          const outcome = await runCursorPrompt({
            cwd: repoPath,
            systemPrompt,
            userPrompt,
            model,
            apiKey,
            readOnlyInstruction: skillTools.readOnlyInstruction,
            abortController,
          });

          setGenAiUsageAttrs(span, outcome.usage);
          if (outcome.sessionId) {
            span.setAttribute('gen_ai.conversation.id', outcome.sessionId);
          }
          span.setAttribute('gen_ai.response.model', model.id);
          span.setAttribute('gen_ai.response.finish_reasons', [outcome.status]);
          if (outcome.status !== 'success') {
            span.setAttribute('error.type', outcome.status);
          }
          if (outcome.text) {
            setGenAiOutputMessagesAttr(span, outcome.text, outcome.status);
          }
          if (outcome.durationMs !== undefined) {
            span.setAttribute('warden.sdk.duration_ms', outcome.durationMs);
          }
          if (outcome.numTurns !== undefined) {
            span.setAttribute('warden.sdk.num_turns', outcome.numTurns);
          }

          const combinedWarnings = [...skillTools.warnings, ...outcome.warnings];
          return {
            result: normalizeRunResult(outcome, model),
            stderr: combinedWarnings.length > 0 ? combinedWarnings.join('\n') : undefined,
          };
        } catch (error) {
          const message = errorMessage(error);
          if (isAuthenticationErrorMessage(message)) {
            span.setAttribute('error.type', 'auth_error');
            return { authError: message };
          }
          span.setAttribute('error.type', error instanceof Error ? error.name : '_OTHER');
          throw error;
        }
      },
    );
  },

  async runAuxiliary<T>(request: AuxiliaryRunRequest<T>): Promise<AuxiliaryRunResult<T>> {
    return runStructured({ kind: 'auxiliary', ...request });
  },

  async runSynthesis<T>(request: SynthesisRunRequest<T>): Promise<AuxiliaryRunResult<T>> {
    return runStructured({ kind: 'synthesis', ...request });
  },
};

/**
 * Lazy accessor for the Cursor account/catalog API. Callers can use this
 * to inspect available models without paying the eager `@cursor/sdk`
 * import cost (which loads a native sqlite3 binding).
 */
export async function getCursorCatalog(): Promise<unknown> {
  const sdk = await loadCursorSdk();
  return sdk.Cursor;
}
