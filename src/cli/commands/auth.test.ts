import { describe, it, expect, vi, beforeEach } from 'vitest';

const authStorageMock = vi.hoisted(() => {
  const data = new Map<string, { type: 'oauth'; refresh: string; access: string; expires: number }>();
  return {
    instance: {
      login: vi.fn(async (provider: string) => {
        data.set(provider, { type: 'oauth', refresh: 'rt-123', access: 'at-123', expires: 0 });
      }),
      logout: vi.fn((provider: string) => {
        data.delete(provider);
      }),
      has: vi.fn((provider: string) => data.has(provider)),
      get: vi.fn((provider: string) => data.get(provider)),
      getAuthStatus: vi.fn((provider: string) => ({
        configured: data.has(provider),
        source: data.has(provider) ? 'stored' : undefined,
      })),
    },
    data,
  };
});

vi.mock('@earendil-works/pi-coding-agent', () => ({
  AuthStorage: {
    create: vi.fn(() => authStorageMock.instance),
  },
}));

vi.mock('../input.js', () => ({
  promptLine: vi.fn(async () => ''),
  UserAbortError: class UserAbortError extends Error {},
}));

import { Reporter } from '../output/reporter.js';
import { detectOutputMode } from '../output/tty.js';
import { Verbosity } from '../output/verbosity.js';
import { runAuth } from './auth.js';

function captureReporter() {
  const lines: string[] = [];
  const reporter = new Reporter(detectOutputMode(false), Verbosity.Normal);
  for (const method of ['text', 'dim', 'success', 'warning', 'error', 'tip', 'step'] as const) {
    const original = reporter[method].bind(reporter);
    reporter[method] = ((message?: string) => {
      if (message !== undefined) lines.push(`${method}: ${message}`);
      original(message ?? '');
    }) as typeof reporter[typeof method];
  }
  reporter.blank = () => undefined;
  return { reporter, lines };
}

describe('runAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authStorageMock.data.clear();
  });

  it('rejects unsupported providers', async () => {
    const { reporter, lines } = captureReporter();
    const code = await runAuth({ subcommand: 'login', provider: 'bogus' }, reporter);
    expect(code).toBe(1);
    expect(lines.some((line) => line.includes('Unsupported provider: bogus'))).toBe(true);
  });

  it('requires a provider for login/logout', async () => {
    const { reporter, lines } = captureReporter();
    const code = await runAuth({ subcommand: 'login' }, reporter);
    expect(code).toBe(1);
    expect(lines.some((line) => line.includes('Provider is required'))).toBe(true);
  });

  it('prints the refresh token after a successful openai-codex login', async () => {
    const { reporter, lines } = captureReporter();
    const code = await runAuth({ subcommand: 'login', provider: 'openai-codex' }, reporter);
    expect(code).toBe(0);
    expect(authStorageMock.instance.login).toHaveBeenCalledWith('openai-codex', expect.anything());
    expect(lines.some((line) => line.includes('WARDEN_OPENAI_CODEX_REFRESH_TOKEN=rt-123'))).toBe(true);
  });

  it('reports status for all supported providers when no provider is given', async () => {
    authStorageMock.data.set('openai-codex', { type: 'oauth', refresh: 'rt', access: 'at', expires: 0 });
    const { reporter, lines } = captureReporter();
    const code = await runAuth({ subcommand: 'status' }, reporter);
    expect(code).toBe(0);
    expect(lines.some((line) => line.includes('openai-codex: configured'))).toBe(true);
    expect(lines.some((line) => line.includes('anthropic: not configured'))).toBe(true);
    expect(lines.some((line) => line.includes('github-copilot: not configured'))).toBe(true);
  });

  it('removes credentials on logout when stored', async () => {
    authStorageMock.data.set('anthropic', { type: 'oauth', refresh: 'rt', access: 'at', expires: 0 });
    const { reporter } = captureReporter();
    const code = await runAuth({ subcommand: 'logout', provider: 'anthropic' }, reporter);
    expect(code).toBe(0);
    expect(authStorageMock.instance.logout).toHaveBeenCalledWith('anthropic');
    expect(authStorageMock.data.has('anthropic')).toBe(false);
  });

  it('warns on logout when no credentials are stored', async () => {
    const { reporter, lines } = captureReporter();
    const code = await runAuth({ subcommand: 'logout', provider: 'openai-codex' }, reporter);
    expect(code).toBe(0);
    expect(authStorageMock.instance.logout).not.toHaveBeenCalled();
    expect(lines.some((line) => line.includes('No stored credentials'))).toBe(true);
  });
});
