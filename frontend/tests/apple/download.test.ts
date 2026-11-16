import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDownloadInfo } from '../../src/apple/download';
import { listVersions } from '../../src/apple/versionFinder';
import { getVersionMetadata } from '../../src/apple/versionLookup';
import { runStore } from '../../src/apple/storeRuntime';
import type { Account, Software } from '../../src/types';
vi.mock('../../src/apple/storeRuntime', async (original) => ({
  ...(await original<typeof import('../../src/apple/storeRuntime')>()),
  runStore: vi.fn(),
}));
const account = {
  email: 'test@example.invalid',
  password: 'synthetic-password',
  passwordToken: 'synthetic-token',
  directoryServicesIdentifier: '123',
  store: '143441',
  cookies: [],
  deviceIdentifier: '020000000001',
} as unknown as Account;
const app = { id: 123, bundleID: 'example.app', price: 0, version: '1' } as Software;
const state = { records: {}, cookies: [] };
describe('modern Store download boundary', () => {
  beforeEach(() => vi.clearAllMocks());
  it('passes the runtime CDN/SINF/binary plist output intact to IPA assembly', async () => {
    const output = {
      downloadURL: 'https://example.itunes.apple.com/app.ipa',
      sinfs: [{ id: 1, sinf: 'c3ludGhldGlj' }],
      bundleShortVersionString: '1.0',
      bundleVersion: '4',
      iTunesMetadata: 'YnBsaXN0MDA=',
    };
    vi.mocked(runStore).mockResolvedValue({ ok: true, value: output, state });
    expect((await getDownloadInfo(account, app, '456')).output).toEqual(output);
    expect(vi.mocked(runStore).mock.calls[0][0]).toMatchObject({
      operation: 'download',
      versionID: '456',
      deviceID: account.deviceIdentifier,
    });
  });
  it('preserves license errors for the existing acquisition UI', async () => {
    vi.mocked(runStore).mockResolvedValue({ ok: false, error: 'license_required', value: null, state });
    await expect(getDownloadInfo(account, app)).rejects.toMatchObject({ code: '9610' });
  });
  it('does not turn token errors into download retries', async () => {
    vi.mocked(runStore).mockResolvedValue({ ok: false, error: 'token_expired', value: null, state });
    await expect(getDownloadInfo(account, app)).rejects.toMatchObject({ code: 'token_expired' });
    expect(runStore).toHaveBeenCalledTimes(1);
  });
  it('uses the same runtime state and endpoint strategy for version operations', async () => {
    vi.mocked(runStore)
      .mockResolvedValueOnce({ ok: true, value: { ExternalVersionIdentifiers: ['1', '2'] }, state })
      .mockResolvedValueOnce({
        ok: true,
        value: { DisplayVersion: '1.0', ReleaseDate: '2026-01-01T00:00:00Z' },
        state,
      });
    expect((await listVersions(account, app)).versions).toEqual(['2', '1']);
    expect((await getVersionMetadata(account, app, '1')).metadata.displayVersion).toBe('1.0');
  });
});
