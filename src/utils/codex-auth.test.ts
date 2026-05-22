import { describe, it, expect, vi } from 'vitest';
import { seedOpenAICodexFromEnv, OPENAI_CODEX_REFRESH_ENV } from './codex-auth.js';

function makeAuthStorage() {
  return {
    setRuntimeApiKey: vi.fn<(provider: string, apiKey: string) => void>(),
  };
}

describe('seedOpenAICodexFromEnv', () => {
  it('does nothing when the refresh token env var is unset', async () => {
    const storage = makeAuthStorage();
    const refresh = vi.fn();
    const warn = vi.fn();

    const seeded = await seedOpenAICodexFromEnv(storage, { env: {}, refresh, warn });

    expect(seeded).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
    expect(storage.setRuntimeApiKey).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('refreshes the token and registers an openai-codex runtime override', async () => {
    const storage = makeAuthStorage();
    const refresh = vi.fn(async () => ({
      access: 'fresh-access-token',
      refresh: 'rt',
      expires: Date.now() + 60_000,
    }));
    const warn = vi.fn();

    const seeded = await seedOpenAICodexFromEnv(storage, {
      env: { [OPENAI_CODEX_REFRESH_ENV]: 'rt' },
      refresh,
      warn,
    });

    expect(seeded).toBe(true);
    expect(refresh).toHaveBeenCalledWith('rt');
    expect(storage.setRuntimeApiKey).toHaveBeenCalledWith('openai-codex', 'fresh-access-token');
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns and does not throw when the refresh call fails', async () => {
    const storage = makeAuthStorage();
    const refresh = vi.fn(async () => {
      throw new Error('network down');
    });
    const warn = vi.fn();

    const seeded = await seedOpenAICodexFromEnv(storage, {
      env: { [OPENAI_CODEX_REFRESH_ENV]: 'rt' },
      refresh,
      warn,
    });

    expect(seeded).toBe(false);
    expect(storage.setRuntimeApiKey).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('network down');
  });

  it('warns when the refresh returns no access token', async () => {
    const storage = makeAuthStorage();
    const refresh = vi.fn(async () => ({ access: '', refresh: 'rt', expires: 0 }));
    const warn = vi.fn();

    const seeded = await seedOpenAICodexFromEnv(storage, {
      env: { [OPENAI_CODEX_REFRESH_ENV]: 'rt' },
      refresh,
      warn,
    });

    expect(seeded).toBe(false);
    expect(storage.setRuntimeApiKey).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('warns when OpenAI rotates the refresh token so the user can update CI', async () => {
    const storage = makeAuthStorage();
    const refresh = vi.fn(async () => ({
      access: 'access',
      refresh: 'new-rotated-token',
      expires: Date.now() + 60_000,
    }));
    const warn = vi.fn();

    await seedOpenAICodexFromEnv(storage, {
      env: { [OPENAI_CODEX_REFRESH_ENV]: 'old-token' },
      refresh,
      warn,
    });

    expect(storage.setRuntimeApiKey).toHaveBeenCalledWith('openai-codex', 'access');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('new-rotated-token');
  });
});
