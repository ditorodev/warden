import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  __setCursorExtensionFactoryForTests,
  modelTargetsCursor,
  registerCursorProvider,
  CursorExtensionUnavailableError,
} from './pi-cursor-extension.js';

interface FakeProviderConfig {
  api: string;
  models: { id: string; name: string }[];
}

function buildFakeModelRegistry() {
  const calls: { method: string; args: unknown[] }[] = [];
  const registry = {
    registerProvider: vi.fn((name: string, config: FakeProviderConfig) => {
      calls.push({ method: 'registerProvider', args: [name, config] });
    }),
    unregisterProvider: vi.fn((name: string) => {
      calls.push({ method: 'unregisterProvider', args: [name] });
    }),
  };
  return { registry, calls };
}

describe('modelTargetsCursor', () => {
  it.each([
    ['cursor/composer-2.5', true],
    ['cursor/composer-2.5:high', true],
    ['cursor/gpt-5.5@1m', true],
    ['anthropic/claude-sonnet-4-6', false],
    ['openai/gpt-5.5', false],
    ['composer-2.5', false],
    [undefined, false],
    ['', false],
  ])('treats %s as cursor=%s', (model, expected) => {
    expect(modelTargetsCursor(model)).toBe(expected);
  });
});

describe('registerCursorProvider', () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it('drives the extension factory against a stub that routes registerProvider into the model registry', async () => {
    const { registry, calls } = buildFakeModelRegistry();
    const factory = vi.fn(async (pi: {
      registerProvider: (n: string, c: FakeProviderConfig) => void;
      registerCommand: (name: string, handler: unknown) => void;
      on: (event: string, handler: unknown) => void;
    }) => {
      // Mirror the real pi-cursor-sdk shape: a few UI/event registrations
      // plus the provider registration that we actually care about.
      pi.registerCommand('cursor-refresh-models', { handler: () => undefined });
      pi.on('session_start', () => undefined);
      pi.registerProvider('cursor', {
        api: 'cursor-sdk',
        models: [
          { id: 'composer-2.5', name: 'Cursor Composer 2.5' },
          { id: 'gpt-5.5', name: 'GPT-5.5 (Cursor)' },
        ],
      });
    });
    restore = __setCursorExtensionFactoryForTests(factory as never);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await registerCursorProvider(registry as any);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      {
        method: 'registerProvider',
        args: [
          'cursor',
          {
            api: 'cursor-sdk',
            models: [
              { id: 'composer-2.5', name: 'Cursor Composer 2.5' },
              { id: 'gpt-5.5', name: 'GPT-5.5 (Cursor)' },
            ],
          },
        ],
      },
    ]);
  });

  it('forwards unregisterProvider on the stub through to the registry', async () => {
    const { registry, calls } = buildFakeModelRegistry();
    restore = __setCursorExtensionFactoryForTests((async (pi: {
      registerProvider: (n: string, c: FakeProviderConfig) => void;
      unregisterProvider?: (n: string) => void;
    }) => {
      pi.registerProvider('cursor', { api: 'cursor-sdk', models: [] });
      pi.unregisterProvider?.('cursor');
    }) as never);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await registerCursorProvider(registry as any);

    expect(calls.map((call) => call.method)).toEqual([
      'registerProvider',
      'unregisterProvider',
    ]);
  });

  it('survives extension factories that touch UI surface (hasUI=false, ui.notify no-op)', async () => {
    const { registry } = buildFakeModelRegistry();
    restore = __setCursorExtensionFactoryForTests((async (pi: {
      hasUI?: boolean;
      ui?: { notify?: (msg: string) => void };
      registerProvider: (n: string, c: FakeProviderConfig) => void;
    }) => {
      // The real extension checks hasUI/ui before notifying; the stub must
      // expose these without throwing.
      if (pi.hasUI) {
        pi.ui?.notify?.('test');
      }
      pi.registerProvider('cursor', { api: 'cursor-sdk', models: [] });
    }) as never);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(registerCursorProvider(registry as any)).resolves.toBeUndefined();
    expect(registry.registerProvider).toHaveBeenCalledTimes(1);
  });
});

describe('CursorExtensionUnavailableError', () => {
  it('preserves the underlying cause and explains how to install', () => {
    const cause = new Error('module not found: pi-cursor-sdk');
    const err = new CursorExtensionUnavailableError(cause);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('CursorExtensionUnavailableError');
    expect(err.message).toContain('pi-cursor-sdk');
    expect(err.message).toContain('module not found');
    expect(err.cause).toBe(cause);
  });
});
