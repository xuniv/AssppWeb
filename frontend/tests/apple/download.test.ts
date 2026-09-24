import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPlist, parsePlist } from '../../src/apple/plist';
import { DownloadError, getDownloadInfo } from '../../src/apple/download';
import { listVersions } from '../../src/apple/versionFinder';
import { getVersionMetadata } from '../../src/apple/versionLookup';
import { appleRequest } from '../../src/apple/request';
import i18n from '../../src/i18n';
import type { AppleResponse } from '../../src/apple/request';
import type { Account, Software } from '../../src/types';

vi.mock('../../src/apple/request', () => ({
  appleRequest: vi.fn(),
}));

const APP_ID = 383539271;
const VERSION_ID = '890992199';

const account: Account = {
  email: 'test@example.com',
  password: 'password',
  appleId: 'test@example.com',
  store: '143466',
  firstName: 'Test',
  lastName: 'User',
  passwordToken: 'token',
  directoryServicesIdentifier: '987654321',
  cookies: [],
  deviceIdentifier: '001122334455',
  pod: '18',
};

const app = {
  id: APP_ID,
  bundleID: 'kr.cultureland',
  name: '컬쳐랜드',
  version: '5.1.2',
} as Software;

function response(status: number, body: string): AppleResponse {
  return { status, statusText: '', headers: {}, rawHeaders: [], body };
}

function plistResponse(dict: Record<string, any>): AppleResponse {
  return response(200, buildPlist(dict));
}

const METADATA = {
  itemId: APP_ID,
  softwareVersionExternalIdentifier: Number(VERSION_ID),
  softwareVersionExternalIdentifiers: [800000001, 850000002, 890992199],
  softwareVersionBundleId: 'kr.cultureland',
  bundleShortVersionString: '5.1.2',
  bundleVersion: '512',
  releaseDate: '2026-09-08T23:14:05Z',
};

const SUCCESS = plistResponse({
  songList: [
    {
      URL: 'https://iosapps.itunes.apple.com/itunes-assets/app.ipa',
      sinfs: [{ id: 0, sinf: new Uint8Array([1, 2, 3]) }],
      metadata: METADATA,
    },
  ],
});

const LOOKUP_OK = response(
  200,
  JSON.stringify({
    results: {
      [String(APP_ID)]: {
        bundleId: 'kr.cultureland',
        offers: [{ version: { externalId: Number(VERSION_ID) } }],
      },
    },
  }),
);

function queue(...responses: AppleResponse[]) {
  for (const r of responses) {
    vi.mocked(appleRequest).mockResolvedValueOnce(r);
  }
}

describe('apple/download', () => {
  beforeEach(() => {
    vi.mocked(appleRequest).mockReset();
  });

  it('recovers an empty volumeStore response through updateProduct', async () => {
    queue(plistResponse({}), LOOKUP_OK, response(500, ''), SUCCESS);

    const { output } = await getDownloadInfo(account, app);

    expect(output.downloadURL).toBe(
      'https://iosapps.itunes.apple.com/itunes-assets/app.ipa',
    );
    expect(output.sinfs).toEqual([{ id: 0, sinf: 'AQID' }]);
    expect(output.bundleShortVersionString).toBe('5.1.2');
    expect(output.bundleVersion).toBe('512');
    const iTunesMetadata = parsePlist(atob(output.iTunesMetadata!));
    expect(iTunesMetadata['apple-id']).toBe('test@example.com');
    expect(iTunesMetadata.softwareVersionBundleId).toBe('kr.cultureland');
  });

  it('surfaces a message-only response instead of no items', async () => {
    queue(plistResponse({ customerMessage: 'App Not Available' }));

    await expect(getDownloadInfo(account, app)).rejects.toThrow(
      'App Not Available',
    );
  });

  it('reports no items when every endpoint is empty', async () => {
    queue(plistResponse({}), LOOKUP_OK, plistResponse({}), plistResponse({}));

    await expect(getDownloadInfo(account, app)).rejects.toThrow(
      i18n.t('errors.download.noItems'),
    );
  });

  it('maps 2034 to an expired password token', async () => {
    queue(plistResponse({ failureType: '2034' }));

    const error = await getDownloadInfo(account, app).catch((e) => e);

    expect(error).toBeInstanceOf(DownloadError);
    expect(error.code).toBe('2034');
    expect(error.message).toBe(i18n.t('errors.download.passwordExpired'));
  });

  it('maps 9610 to license required', async () => {
    queue(plistResponse({ failureType: '9610' }));

    await expect(getDownloadInfo(account, app)).rejects.toThrow(
      i18n.t('errors.download.licenseRequired'),
    );
  });

  it('lists versions through the fallback chain', async () => {
    queue(plistResponse({}), LOOKUP_OK, SUCCESS);

    const { versions } = await listVersions(account, app);

    expect(versions).toEqual(['890992199', '850000002', '800000001']);
  });

  it('looks up version metadata with the requested version pinned', async () => {
    queue(plistResponse({}), SUCCESS);

    const { metadata } = await getVersionMetadata(account, app, VERSION_ID);

    expect(metadata.displayVersion).toBe('5.1.2');
    const [primary, redownload] = vi
      .mocked(appleRequest)
      .mock.calls.map((call) => parsePlist(call[0].body ?? ''));
    expect(primary.externalVersionId).toBe(VERSION_ID);
    expect(redownload.appExtVrsId).toBe(VERSION_ID);
  });
});
