import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import {
  __setCursorSdkLoaderForTests,
  cursorRuntime,
  parseCursorModelSelector,
  resolveCursorSkillTools,
} from './cursor.js';

interface FakeAgent {
  agentId: string;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  [Symbol.asyncDispose]: ReturnType<typeof vi.fn>;
}

interface FakeRun {
  id: string;
  status: 'running' | 'finished' | 'error' | 'cancelled';
  stream: ReturnType<typeof vi.fn>;
  wait: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  durationMs?: number;
  result?: string;
}

interface CursorMocks {
  agent: FakeAgent;
  run: FakeRun;
  capturedSendArgs: { message: string; options: { onDelta?: (a: { update: unknown }) => void } | undefined } | undefined;
  agentCreateOptions: unknown;
  restore?: () => void;
}

const cursorMocks: CursorMocks = {
  agent: {} as FakeAgent,
  run: {} as FakeRun,
  capturedSendArgs: undefined,
  agentCreateOptions: undefined,
};

function installFakeSdk(): void {
  cursorMocks.restore = __setCursorSdkLoaderForTests({
    Agent: {
      create: vi.fn(async (options: unknown) => {
        cursorMocks.agentCreateOptions = options;
        return cursorMocks.agent;
      }),
    },
    Cursor: {},
  });
}

function uninstallFakeSdk(): void {
  cursorMocks.restore?.();
  cursorMocks.restore = undefined;
}

function buildRun(streamEvents: unknown[], waitOverrides: Partial<{ status: 'finished' | 'error' | 'cancelled'; result?: string; durationMs?: number }> = {}): FakeRun {
  return {
    id: 'run-1',
    status: 'finished',
    durationMs: 1234,
    result: 'final output',
    stream: vi.fn(async function* () {
      for (const event of streamEvents) {
        yield event;
      }
    }),
    wait: vi.fn(async () => ({
      status: waitOverrides.status ?? 'finished',
      result: waitOverrides.result ?? 'final output',
      durationMs: waitOverrides.durationMs ?? 1234,
    })),
    cancel: vi.fn(async () => undefined),
  };
}

function buildAgent(run: FakeRun): FakeAgent {
  const agent = {
    agentId: 'agent-abc',
    send: vi.fn(async (message: string, options) => {
      cursorMocks.capturedSendArgs = { message, options };
      return run;
    }),
    close: vi.fn(() => undefined),
    [Symbol.asyncDispose]: vi.fn(async () => undefined),
  };
  return agent;
}

function baseSkillRequest() {
  return {
    apiKey: 'cursor-test-key',
    systemPrompt: 'You are a code reviewer.',
    userPrompt: 'Find bugs in src/foo.ts',
    repoPath: '/repo',
    skillName: 'security-review',
    options: {
      model: 'composer-2.5',
    },
  };
}

describe('parseCursorModelSelector', () => {
  it('returns composer-2.5 when no model is provided', () => {
    expect(parseCursorModelSelector(undefined)).toEqual({ id: 'composer-2.5' });
  });

  it('returns the bare id when no query string is present', () => {
    expect(parseCursorModelSelector('composer-2.5')).toEqual({ id: 'composer-2.5' });
  });

  it('parses model parameters from a query-string suffix', () => {
    expect(parseCursorModelSelector('composer-2.5?thinking=high')).toEqual({
      id: 'composer-2.5',
      params: [{ id: 'thinking', value: 'high' }],
    });
  });

  it('supports multiple parameters separated by ampersand', () => {
    expect(parseCursorModelSelector('composer-2.5?thinking=high&temperature=0')).toEqual({
      id: 'composer-2.5',
      params: [
        { id: 'thinking', value: 'high' },
        { id: 'temperature', value: '0' },
      ],
    });
  });
});

describe('resolveCursorSkillTools', () => {
  it('returns a read-only instruction for default analysis runs', () => {
    const { warnings, readOnlyInstruction } = resolveCursorSkillTools(undefined, false);
    expect(warnings).toEqual([]);
    expect(readOnlyInstruction).toContain('read-only review mode');
  });

  it('drops the read-only instruction when mutating tools are explicitly allowed', () => {
    const { readOnlyInstruction } = resolveCursorSkillTools({ allowed: ['Write', 'Edit'] }, true);
    expect(readOnlyInstruction).toBeUndefined();
  });

  it('warns about unsupported tools and best-effort-only mutating restrictions', () => {
    const { warnings } = resolveCursorSkillTools(
      { allowed: ['Read', 'WebFetch', 'Bash'] },
      false,
    );
    expect(warnings).toContain('Cursor runtime ignored unsupported tool: WebFetch');
    expect(warnings.some((line) => line.includes('mutating tool'))).toBe(true);
  });
});

describe('cursorRuntime.runSkill', () => {
  beforeEach(() => {
    cursorMocks.capturedSendArgs = undefined;
    cursorMocks.agentCreateOptions = undefined;
    cursorMocks.run = buildRun([
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: '{"findings":[]}' }] },
      },
    ]);
    cursorMocks.agent = buildAgent(cursorMocks.run);
    installFakeSdk();
  });

  afterEach(() => {
    uninstallFakeSdk();
    vi.clearAllMocks();
  });

  it('returns an auth error when no API key is available', async () => {
    const previous = process.env['CURSOR_API_KEY'];
    const previousWarden = process.env['WARDEN_CURSOR_API_KEY'];
    delete process.env['CURSOR_API_KEY'];
    delete process.env['WARDEN_CURSOR_API_KEY'];
    try {
      const response = await cursorRuntime.runSkill({
        systemPrompt: 'system',
        userPrompt: 'user',
        repoPath: '/repo',
        skillName: 'test',
        options: {},
      });
      expect(response.result).toBeUndefined();
      expect(response.authError).toContain('Cursor API key not found');
    } finally {
      if (previous !== undefined) process.env['CURSOR_API_KEY'] = previous;
      if (previousWarden !== undefined) process.env['WARDEN_CURSOR_API_KEY'] = previousWarden;
    }
  });

  it('creates a local Cursor agent with the provided cwd and model', async () => {
    await cursorRuntime.runSkill(baseSkillRequest());

    expect(cursorMocks.agentCreateOptions).toMatchObject({
      apiKey: 'cursor-test-key',
      model: { id: 'composer-2.5' },
      local: { cwd: '/repo' },
    });
  });

  it('composes the system prompt and read-only instruction into the user message', async () => {
    await cursorRuntime.runSkill(baseSkillRequest());

    const sent = cursorMocks.capturedSendArgs?.message ?? '';
    expect(sent).toContain('# System instructions');
    expect(sent).toContain('You are a code reviewer.');
    expect(sent).toContain('# Tool policy');
    expect(sent).toContain('read-only review mode');
    expect(sent).toContain('# Task');
    expect(sent).toContain('Find bugs in src/foo.ts');
  });

  it('omits the read-only instruction for trusted writer runs', async () => {
    await cursorRuntime.runSkill({
      ...baseSkillRequest(),
      allowMutatingTools: true,
    });

    const sent = cursorMocks.capturedSendArgs?.message ?? '';
    expect(sent).not.toContain('# Tool policy');
    expect(sent).not.toContain('read-only review mode');
  });

  it('extracts assistant text and surfaces usage from turn-ended deltas', async () => {
    cursorMocks.run = buildRun([
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'analysis result' }] },
      },
    ]);
    cursorMocks.agent = buildAgent(cursorMocks.run);
    // Simulate the real SDK firing onDelta synchronously inside send().
    cursorMocks.agent.send = vi.fn(async (message: string, options) => {
      cursorMocks.capturedSendArgs = { message, options };
      options?.onDelta?.({
        update: {
          type: 'turn-ended',
          usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5 },
        },
      });
      return cursorMocks.run;
    }) as FakeAgent['send'];

    const response = await cursorRuntime.runSkill(baseSkillRequest());

    expect(response.result?.status).toBe('success');
    expect(response.result?.text).toBe('analysis result');
    expect(response.result?.responseModel).toBe('composer-2.5');
    expect(response.result?.sessionId).toBe('agent-abc');
    expect(response.result?.usage).toMatchObject({
      inputTokens: 115,
      outputTokens: 50,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 5,
      costUSD: 0,
    });
  });

  it('reports an aborted status when run.wait reports cancellation', async () => {
    cursorMocks.run = buildRun(
      [{ type: 'assistant', message: { content: [{ type: 'text', text: '' }] } }],
      { status: 'cancelled' },
    );
    cursorMocks.agent = buildAgent(cursorMocks.run);

    const response = await cursorRuntime.runSkill(baseSkillRequest());
    expect(response.result?.status).toBe('aborted');
  });

  it('surfaces tool warnings via stderr', async () => {
    const response = await cursorRuntime.runSkill({
      ...baseSkillRequest(),
      tools: { allowed: ['Read', 'WebFetch', 'Bash'] },
    });
    expect(response.stderr).toContain('Cursor runtime ignored unsupported tool: WebFetch');
  });
});

describe('cursorRuntime structured calls', () => {
  beforeEach(() => {
    cursorMocks.capturedSendArgs = undefined;
    cursorMocks.run = buildRun(
      [
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: '{"ok":true}' }] },
        },
      ],
      { status: 'finished', result: '{"ok":true}' },
    );
    cursorMocks.agent = buildAgent(cursorMocks.run);
    installFakeSdk();
  });

  afterEach(() => {
    uninstallFakeSdk();
    vi.clearAllMocks();
  });

  it('parses and validates auxiliary JSON output', async () => {
    const result = await cursorRuntime.runAuxiliary({
      task: 'extraction',
      agentName: 'test-skill',
      apiKey: 'cursor-test-key',
      prompt: 'Return {"ok": true}',
      schema: z.object({ ok: z.boolean() }),
      model: 'composer-2.5',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ ok: true });
    }
  });

  it('fails with a clear error when no API key is supplied', async () => {
    const previous = process.env['CURSOR_API_KEY'];
    const previousWarden = process.env['WARDEN_CURSOR_API_KEY'];
    delete process.env['CURSOR_API_KEY'];
    delete process.env['WARDEN_CURSOR_API_KEY'];
    try {
      const result = await cursorRuntime.runAuxiliary({
        task: 'extraction',
        prompt: 'Return {"ok": true}',
        schema: z.object({ ok: z.boolean() }),
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Cursor API key required');
      }
    } finally {
      if (previous !== undefined) process.env['CURSOR_API_KEY'] = previous;
      if (previousWarden !== undefined) process.env['WARDEN_CURSOR_API_KEY'] = previousWarden;
    }
  });

  it('rejects auxiliary tool calls (Cursor does not support tool callbacks)', async () => {
    const result = await cursorRuntime.runAuxiliary({
      task: 'extraction',
      apiKey: 'cursor-test-key',
      prompt: 'extract',
      schema: z.object({ ok: z.boolean() }),
      tools: [{ name: 'fetch', description: 'fetch a URL', inputSchema: {} }],
      executeTool: async () => '',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('does not support auxiliary tool callbacks');
    }
  });

  it('returns a validation error when schema does not match', async () => {
    cursorMocks.run = buildRun(
      [{ type: 'assistant', message: { content: [{ type: 'text', text: '{"ok":"not a boolean"}' }] } }],
      { result: '{"ok":"not a boolean"}' },
    );
    cursorMocks.agent = buildAgent(cursorMocks.run);

    const result = await cursorRuntime.runAuxiliary({
      task: 'extraction',
      apiKey: 'cursor-test-key',
      prompt: 'extract',
      schema: z.object({ ok: z.boolean() }),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Validation failed');
    }
  });
});
