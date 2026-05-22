/**
 * ChatGPT Codex (OpenAI OAuth) bootstrap for the Pi runtime.
 *
 * Two paths feed credentials into Pi's AuthStorage for the `openai-codex`
 * provider:
 *
 * 1. Local dev: the user runs `warden auth login openai-codex` once and the
 *    resulting OAuth credentials are persisted to `~/.pi/agent/auth.json`.
 *    AuthStorage.create() reads them automatically.
 *
 * 2. CI / GitHub Actions: the user exports the long-lived refresh token as
 *    `WARDEN_OPENAI_CODEX_REFRESH_TOKEN`. Browser-callback OAuth doesn't
 *    work inside a runner, so we refresh the token at startup and inject
 *    the resulting access token as a runtime API-key override. Nothing is
 *    written to disk; the override is in-memory for the duration of the run.
 */
import type { AuthStorage } from '@earendil-works/pi-coding-agent';

export const OPENAI_CODEX_PROVIDER = 'openai-codex';
export const OPENAI_CODEX_REFRESH_ENV = 'WARDEN_OPENAI_CODEX_REFRESH_TOKEN';

interface RefreshedCredentials {
  access: string;
  refresh: string;
  expires: number;
}

/**
 * Token refresher. Defaults to pi-ai's built-in OAuth refresh; tests can
 * override to avoid network calls.
 */
export type OpenAICodexRefresher = (refreshToken: string) => Promise<RefreshedCredentials>;

async function defaultRefresher(refreshToken: string): Promise<RefreshedCredentials> {
  const { refreshOpenAICodexToken } = await import('@earendil-works/pi-ai/oauth');
  const result = await refreshOpenAICodexToken(refreshToken);
  return {
    access: String(result.access),
    refresh: String(result.refresh),
    expires: Number(result.expires),
  };
}

export interface SeedOptions {
  env?: NodeJS.ProcessEnv;
  refresh?: OpenAICodexRefresher;
  warn?: (message: string) => void;
}

/**
 * If WARDEN_OPENAI_CODEX_REFRESH_TOKEN is set, exchange it for a fresh
 * access token and register it as a runtime override on the given
 * AuthStorage. Returns true when a token was injected.
 *
 * Failures are surfaced via the warn() callback and treated as
 * non-fatal — the rest of Warden's auth resolution (auth.json, other env
 * vars) still runs.
 */
export async function seedOpenAICodexFromEnv(
  authStorage: Pick<AuthStorage, 'setRuntimeApiKey'>,
  options: SeedOptions = {},
): Promise<boolean> {
  const env = options.env ?? process.env;
  const refreshToken = env[OPENAI_CODEX_REFRESH_ENV];
  if (!refreshToken) {
    return false;
  }

  const refresh = options.refresh ?? defaultRefresher;
  const warn = options.warn ?? ((message: string) => console.warn(`warden: ${message}`));

  let credentials: RefreshedCredentials;
  try {
    credentials = await refresh(refreshToken);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    warn(`Failed to refresh ChatGPT Codex token from ${OPENAI_CODEX_REFRESH_ENV}: ${detail}`);
    return false;
  }

  if (!credentials.access) {
    warn(`ChatGPT Codex token refresh returned no access token; ignoring ${OPENAI_CODEX_REFRESH_ENV}`);
    return false;
  }

  authStorage.setRuntimeApiKey(OPENAI_CODEX_PROVIDER, credentials.access);

  if (credentials.refresh && credentials.refresh !== refreshToken) {
    warn(
      `ChatGPT Codex returned a rotated refresh token. ` +
      `Update the ${OPENAI_CODEX_REFRESH_ENV} secret to: ${credentials.refresh}`,
    );
  }

  return true;
}
