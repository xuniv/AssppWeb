import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runStore } from '../../src/apple/storeRuntime';
import { useAccountsStore } from '../../src/store/accounts';
import { useSettingsStore } from '../../src/store/settings';
import { serverRuntimeTransportAllowed } from '../../src/utils/runtimeTransport';

const input = { operation: 'login', deviceID: '020000000001', email: 'synthetic@example.test', password: 'synthetic' };
const output = { ok: true, state: { records: {}, cookies: [] }, value: 'done' };
const workers: FakeWorker[] = [];
let holdClient = false;
class FakeWorker {
  onmessage?: (event: { data: unknown }) => void;
  onerror?: () => void;
  terminate = vi.fn();
  constructor() {
    workers.push(this);
  }
  postMessage(data: { type: string; id: number }) {
    if (data.type !== 'run' || holdClient) return;
    queueMicrotask(() => this.onmessage?.({ data: { type: 'result', id: data.id, value: JSON.stringify(output) } }));
  }
}

beforeEach(() => {
  // Changing the mode also closes any worker retained by the previous test.
  useSettingsStore.getState().setStoreRuntimeMode('server');
  useSettingsStore.getState().setStoreRuntimeMode('client');
  useAccountsStore.setState({ accounts: [] });
  workers.length = 0;
  holdClient = false;
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('location', {
    protocol: 'https:',
    hostname: 'asspp.example.test',
    href: 'https://asspp.example.test/',
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(output))));
});

afterEach(() => {
  useSettingsStore.getState().setStoreRuntimeMode('client');
  vi.unstubAllGlobals();
});

describe('explicit Store execution choice', () => {
  it('keeps default requests on the device and never sends credentials to the HTTP API', async () => {
    expect(useSettingsStore.getState().storeRuntimeMode).toBe('client');
    await expect(runStore(input)).resolves.toMatchObject({ ok: true });
    expect(workers).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses only the same-origin server after explicit opt-in without loading a browser worker', async () => {
    useSettingsStore.getState().setStoreRuntimeMode('server');
    await expect(runStore(input)).resolves.toMatchObject({ ok: true });
    expect(workers).toHaveLength(0);
    expect(fetch).toHaveBeenCalledWith(
      '/api/store-runtime',
      expect.objectContaining({
        body: expect.stringContaining('synthetic'),
        headers: expect.objectContaining({ 'X-Asspp-Server-Consent': 'credentials-v1' }),
        cache: 'no-store',
        redirect: 'error',
      }),
    );
  });

  it('does not silently fall back to either transport after an error', async () => {
    useSettingsStore.getState().setStoreRuntimeMode('server');
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 503 }));
    await expect(runStore(input)).rejects.toThrow('HTTP 503');
    expect(workers).toHaveLength(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects queued server work when consent is revoked before transfer', async () => {
    holdClient = true;
    const client = runStore(input);
    const clientResult = client.catch(() => undefined);
    await Promise.resolve();
    useSettingsStore.getState().setStoreRuntimeMode('server');
    const server = runStore(input);
    const serverResult = expect(server).rejects.toThrow();
    useSettingsStore.getState().setStoreRuntimeMode('client');
    await Promise.all([clientResult, serverResult]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('invalidates old queued requests even when the setting returns to its previous mode', async () => {
    holdClient = true;
    const client = runStore(input);
    const clientResult = client.catch(() => undefined);
    await Promise.resolve();
    useSettingsStore.getState().setStoreRuntimeMode('server');
    const server = runStore(input);
    const serverResult = expect(server).rejects.toThrow();
    useSettingsStore.getState().setStoreRuntimeMode('client');
    useSettingsStore.getState().setStoreRuntimeMode('server');
    await Promise.all([clientResult, serverResult]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('blocks credential transfers over remote HTTP even with a previously saved consent', async () => {
    useSettingsStore.getState().setStoreRuntimeMode('server');
    vi.stubGlobal('location', { protocol: 'http:', hostname: '192.168.1.2' });
    await expect(runStore(input)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(workers).toHaveLength(0);
  });
});

describe('credential transport origin', () => {
  it.each([
    ['https:', 'asspp.example.test', true],
    ['http:', '192.168.1.2', false],
    ['http:', 'asspp.example.test', false],
    ['http:', 'localhost', true],
    ['http:', '127.0.0.1', true],
    ['http:', '[::1]', true],
    ['http:', 'localhost.evil.test', false],
  ])('checks %s//%s', (protocol, hostname, allowed) => {
    vi.stubGlobal('location', { protocol, hostname });
    expect(serverRuntimeTransportAllowed()).toBe(allowed);
  });
});
