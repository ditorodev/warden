/**
 * `warden auth` command: log in to OAuth-based providers so Pi's
 * AuthStorage has credentials Warden can use.
 *
 * Supports `openai-codex` (ChatGPT subscription), `anthropic` (Claude
 * Pro/Max), and `github-copilot`. After login, prints the long-lived
 * refresh token along with the env-var name to plug into GitHub Actions
 * secrets — that's the path Warden uses in CI, where the browser-based
 * OAuth callback can't run.
 */
import { AuthStorage } from '@earendil-works/pi-coding-agent';
import type { OAuthLoginCallbacks } from '@earendil-works/pi-ai/oauth';
import { promptLine, UserAbortError } from '../input.js';
import type { Reporter } from '../output/reporter.js';

const SUPPORTED_PROVIDERS = ['openai-codex', 'anthropic', 'github-copilot'] as const;
type Provider = typeof SUPPORTED_PROVIDERS[number];

const REFRESH_TOKEN_ENV: Record<Provider, string> = {
  'openai-codex': 'WARDEN_OPENAI_CODEX_REFRESH_TOKEN',
  anthropic: 'WARDEN_ANTHROPIC_OAUTH_REFRESH_TOKEN',
  'github-copilot': 'WARDEN_GITHUB_COPILOT_REFRESH_TOKEN',
};

export type AuthSubcommand = 'login' | 'logout' | 'status';

export interface AuthOptions {
  subcommand: AuthSubcommand;
  provider?: string;
}

function isSupportedProvider(provider: string): provider is Provider {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(provider);
}

function describeProviders(): string {
  return SUPPORTED_PROVIDERS.join(', ');
}

function buildLoginCallbacks(reporter: Reporter, signal: AbortSignal): OAuthLoginCallbacks {
  return {
    onAuth(info) {
      reporter.text(`Open this URL to authenticate:`);
      reporter.text(`  ${info.url}`);
      if (info.instructions) {
        reporter.dim(info.instructions);
      }
    },
    async onPrompt(prompt) {
      const message = prompt.placeholder ? `${prompt.message} (${prompt.placeholder}): ` : `${prompt.message}: `;
      const value = await promptLine(message);
      if (!value && !prompt.allowEmpty) {
        throw new UserAbortError();
      }
      return value;
    },
    onProgress(message) {
      reporter.dim(message);
    },
    signal,
  };
}

async function runLogin(provider: Provider, reporter: Reporter): Promise<number> {
  const authStorage = AuthStorage.create();
  const controller = new AbortController();
  const callbacks = buildLoginCallbacks(reporter, controller.signal);

  reporter.text(`Logging in to ${provider}…`);
  try {
    await authStorage.login(provider, callbacks);
  } catch (error) {
    if (error instanceof UserAbortError) {
      reporter.warning('Login aborted.');
      return 130;
    }
    const detail = error instanceof Error ? error.message : String(error);
    reporter.error(`Login failed: ${detail}`);
    return 1;
  }

  const credential = authStorage.get(provider);
  if (!credential || credential.type !== 'oauth') {
    reporter.error('Login completed but no OAuth credential was persisted.');
    return 1;
  }

  reporter.success(`Logged in to ${provider}. Credentials saved to ~/.pi/agent/auth.json.`);
  reporter.blank();
  reporter.text('For GitHub Actions, set this repository secret:');
  reporter.text(`  ${REFRESH_TOKEN_ENV[provider]}=${credential.refresh}`);
  reporter.blank();
  reporter.dim('Warden will refresh the access token on each run.');
  return 0;
}

function runLogout(provider: Provider, reporter: Reporter): number {
  const authStorage = AuthStorage.create();
  if (!authStorage.has(provider)) {
    reporter.warning(`No stored credentials for ${provider}.`);
    return 0;
  }
  authStorage.logout(provider);
  reporter.success(`Removed ${provider} credentials from ~/.pi/agent/auth.json.`);
  return 0;
}

function runStatus(provider: Provider | undefined, reporter: Reporter): number {
  const authStorage = AuthStorage.create();
  const providers = provider ? [provider] : [...SUPPORTED_PROVIDERS];
  for (const id of providers) {
    const status = authStorage.getAuthStatus(id);
    const envValue = process.env[REFRESH_TOKEN_ENV[id]];
    const envNote = envValue ? `, ${REFRESH_TOKEN_ENV[id]} set in env` : '';
    if (status.configured) {
      const source = status.source ? ` (${status.source}${status.label ? `: ${status.label}` : ''})` : '';
      reporter.text(`  ${id}: configured${source}${envNote}`);
    } else {
      reporter.text(`  ${id}: not configured${envNote}`);
    }
  }
  return 0;
}

export async function runAuth(options: AuthOptions, reporter: Reporter): Promise<number> {
  const { subcommand, provider } = options;

  if (subcommand === 'status') {
    if (provider && !isSupportedProvider(provider)) {
      reporter.error(`Unsupported provider: ${provider}. Supported: ${describeProviders()}.`);
      return 1;
    }
    return runStatus(provider as Provider | undefined, reporter);
  }

  if (!provider) {
    reporter.error(`Provider is required. Supported: ${describeProviders()}.`);
    reporter.tip(`Example: warden auth ${subcommand} openai-codex`);
    return 1;
  }

  if (!isSupportedProvider(provider)) {
    reporter.error(`Unsupported provider: ${provider}. Supported: ${describeProviders()}.`);
    return 1;
  }

  if (subcommand === 'login') {
    return runLogin(provider, reporter);
  }
  return runLogout(provider, reporter);
}
