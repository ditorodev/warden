/**
 * Pi extension loader for Cursor models (Composer 2.5 et al).
 *
 * Warden integrates Cursor through `pi-cursor-sdk`, a Pi extension that
 * registers Cursor as a provider so users can select `cursor/composer-2.5`,
 * `cursor/composer-2.5:high`, etc. through the standard Pi provider/model
 * selector. The package's default export is an `ExtensionFactory`
 * `(pi: ExtensionAPI) => Promise<void>` that:
 *
 *   - fetches the live Cursor model catalog (with bundled fallback)
 *   - calls `pi.registerProvider("cursor", { api: "cursor-sdk", ... })`
 *   - registers a `/cursor-refresh-models` slash command and several
 *     interactive UI helpers (native tool display, session cwd, etc.)
 *
 * Two integration constraints shape this module:
 *
 * 1. **Lifecycle.** Pi's `DefaultResourceLoader` calls extension factories
 *    during `reload()`, but `pi.registerProvider` is a *pending stub* at
 *    that point — registrations are buffered and flushed only when
 *    `createAgentSession` calls `runner.bindCore`. Warden resolves the
 *    model BEFORE `createAgentSession`, which means resource-loader-driven
 *    factories would register the provider too late. So we bypass that
 *    path: we invoke the extension factory ourselves against a minimal
 *    `ExtensionAPI` stub that routes `registerProvider` straight to
 *    `modelRegistry.registerProvider`. All other ExtensionAPI surface
 *    (event handlers, slash commands, UI helpers) is no-op'd; Warden's
 *    headless analysis loop doesn't use them anyway.
 *
 * 2. **Bundling.** `pi-cursor-sdk` static-imports `@cursor/sdk`, which has
 *    a native sqlite3 binding and broken `@anysphere/*` d.ts references
 *    that ncc can't bundle. We resolve the module path through an opaque
 *    `Function`-constructed `import()` so static analyzers can't follow
 *    it. The CLI installs the extension via `optionalDependencies`; the
 *    GitHub Action bundle does NOT include Cursor support — picking
 *    `cursor/...` from inside the action errors with the message below.
 *
 * The extension is loaded lazily on first cursor-model request and cached
 * for the life of the process.
 */
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';

const opaqueImport = Function('s', 'return import(s)') as (
  specifier: string,
) => Promise<unknown>;

type ProviderConfig = Parameters<ModelRegistry['registerProvider']>[1];
type CursorExtensionFactory = (pi: CursorExtensionApi) => void | Promise<void>;

/**
 * Subset of Pi's `ExtensionAPI` that the cursor extension actually needs
 * to register itself. Everything beyond `registerProvider` /
 * `registerCommand` / `on` is replaced with safe no-ops because Warden's
 * headless analysis loop doesn't expose UI, slash commands, or session
 * event handlers from extensions.
 */
interface CursorExtensionApi {
  registerProvider(name: string, config: ProviderConfig): void;
  unregisterProvider?(name: string): void;
  registerCommand?(name: string, handler: unknown): void;
  registerTool?(definition: unknown): void;
  on?(event: string, handler: unknown): void;
  emit?(event: string, payload: unknown): void;
  ui?: unknown;
  hasUI?: boolean;
}

interface PiCursorSdkModule {
  default: CursorExtensionFactory;
}

export class CursorExtensionUnavailableError extends Error {
  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `Cursor models require the optional pi-cursor-sdk dependency. ` +
      `Install it with \`pnpm add pi-cursor-sdk\` (or npm/yarn equivalent) ` +
      `and ensure CURSOR_API_KEY is set. Underlying error: ${detail}`,
    );
    this.name = 'CursorExtensionUnavailableError';
    this.cause = cause;
  }
}

/** Return true when a Pi model selector targets the cursor provider. */
export function modelTargetsCursor(model: string | undefined): boolean {
  return Boolean(model && model.startsWith('cursor/'));
}

let cachedFactory: Promise<CursorExtensionFactory> | undefined;

async function loadCursorExtensionFactory(): Promise<CursorExtensionFactory> {
  if (!cachedFactory) {
    cachedFactory = (async () => {
      try {
        const mod = (await opaqueImport('pi-cursor-sdk')) as PiCursorSdkModule;
        if (typeof mod.default !== 'function') {
          throw new Error('pi-cursor-sdk default export is not an extension factory');
        }
        return mod.default;
      } catch (error) {
        throw new CursorExtensionUnavailableError(error);
      }
    })();
  }
  return cachedFactory;
}

function buildStubApi(modelRegistry: ModelRegistry): CursorExtensionApi {
  return {
    registerProvider(name, config) {
      modelRegistry.registerProvider(name, config);
    },
    unregisterProvider(name) {
      modelRegistry.unregisterProvider(name);
    },
    // Event handlers, slash commands, and UI helpers are not used by
    // Warden's headless analysis loop. Accept-and-ignore keeps the
    // extension's init from throwing on these calls.
    registerCommand() { /* no-op */ },
    registerTool() { /* no-op */ },
    on() { /* no-op */ },
    emit() { /* no-op */ },
    hasUI: false,
    ui: {
      notify() { /* no-op */ },
    },
  };
}

/**
 * Register the cursor provider on the given model registry by loading
 * pi-cursor-sdk and invoking its extension factory against a minimal
 * Warden-owned ExtensionAPI stub. After this resolves, the registry can
 * resolve models like `cursor/composer-2.5` via `find('cursor', 'composer-2.5')`.
 *
 * No-op when pi-cursor-sdk hasn't been requested yet — the caller is
 * expected to gate this on `modelTargetsCursor(model)`.
 */
export async function registerCursorProvider(
  modelRegistry: ModelRegistry,
): Promise<void> {
  const factory = await loadCursorExtensionFactory();
  await factory(buildStubApi(modelRegistry));
}

/**
 * Test seam: replace the cached factory loader so tests don't pull in
 * the real `pi-cursor-sdk` (which static-imports `@cursor/sdk` and its
 * native deps). Returns a restore function.
 */
export function __setCursorExtensionFactoryForTests(
  factory: CursorExtensionFactory | undefined,
): () => void {
  const previous = cachedFactory;
  cachedFactory = factory ? Promise.resolve(factory) : undefined;
  return () => {
    cachedFactory = previous;
  };
}
