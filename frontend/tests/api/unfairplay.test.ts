import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runServerUnfairPlay, safeUnfairPlaySummary } from '../../src/api/unfairplay';
import { serverRuntimeTransportAllowed } from '../../src/utils/runtimeTransport';

vi.mock('../../src/api/client', () => ({ authHeaders: () => ({ 'X-Access-Token': 'synthetic-access' }) }));
vi.mock('../../src/utils/runtimeTransport', () => ({ serverRuntimeTransportAllowed: vi.fn(() => true) }));
beforeEach(() => vi.mocked(serverRuntimeTransportAllowed).mockReturnValue(true));
afterEach(() => vi.unstubAllGlobals());

describe('explicit UnfairPlay server transport', () => {
  it('omits upstream private evidence and invalid metric values from the downloadable summary', () => {
    expect(
      safeUnfairPlaySummary({
        plaintextVerified: false,
        decryptedPages: 3,
        modelVersions: [2, 3],
        model_sha256: 'private',
        selectors: ['private'],
        path: '/private/app',
        outputSHA256: 'private',
        modelCount: -1,
        removedLicenseFiles: Infinity,
      }),
    ).toEqual({ plaintextVerified: false, decryptedPages: 3, modelVersions: [2, 3] });
  });
  it('sends only selected model blobs and a typed existing source, never refetching the IPA', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: {
          'X-Asspp-Unfairplay-Summary': btoa(JSON.stringify({ plaintextVerified: false, decryptedPages: 2 })),
        },
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    const signal = new AbortController().signal;
    const result = await runServerUnfairPlay({
      operation: 'decrypt',
      source: { kind: 'package', id: 'fixture', accountHash: 'synthetic-hash' },
      models: [new Blob(['selected-model'])],
      stripAccountData: false,
      signal,
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe('/api/unfairplay/decrypt');
    expect(options.headers).toMatchObject({
      'X-Access-Token': 'synthetic-access',
      'X-Asspp-Unfairplay-Consent': 'model-v1',
    });
    expect(options.body.get('ipa')).toBeNull();
    expect(JSON.parse(options.body.get('source'))).toEqual({
      kind: 'package',
      id: 'fixture',
      accountHash: 'synthetic-hash',
    });
    expect(options.body.getAll('models')).toHaveLength(1);
    expect(options.body.get('stripAccountData')).toBe('false');
    expect(options.signal).toBe(signal);
    expect(options.redirect).toBe('error');
    expect(result.summary.plaintextVerified).toBe(false);
    expect(result.ipa?.size).toBe(3);
  });
  it('never transfers models for the separate account-data stripping operation', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('new-ipa'));
    vi.stubGlobal('fetch', fetcher);
    await runServerUnfairPlay({
      operation: 'strip_account_data',
      input: new Blob(['original']),
      models: [new Blob(['private-model'])],
      stripAccountData: false,
      signal: new AbortController().signal,
    });
    expect(fetcher.mock.calls[0][1].body.getAll('models')).toEqual([]);
    expect(fetcher.mock.calls[0][1].body.get('stripAccountData')).toBeNull();
    expect(fetcher.mock.calls[0][1].body.get('ipa').size).toBe(8);
  });
  it('blocks remote HTTP before transferring anything and does not retry failed server requests', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', fetcher);
    const request = {
      operation: 'doctor' as const,
      input: new Blob(['fixture']),
      models: [],
      stripAccountData: false,
      signal: new AbortController().signal,
    };
    vi.mocked(serverRuntimeTransportAllowed).mockReturnValue(false);
    await expect(runServerUnfairPlay(request)).rejects.toThrow('https_required');
    expect(fetcher).not.toHaveBeenCalled();
    vi.mocked(serverRuntimeTransportAllowed).mockReturnValue(true);
    await expect(runServerUnfairPlay(request)).rejects.toThrow('unfairplay_http_503');
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
