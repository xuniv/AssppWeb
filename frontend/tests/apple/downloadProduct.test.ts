import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPlist, parsePlist } from '../../src/apple/plist';
import {
  DownloadError,
  isEmptyDownloadProductResponse,
  isUnavailableDownloadProductResponse,
  lookupLatestExternalVersionId,
  sendDownloadProduct,
} from '../../src/apple/downloadProduct';
import { appleRequest } from '../../src/apple/request';
import i18n from '../../src/i18n';
import type {
  AppleRequestOptions,
  AppleResponse,
} from '../../src/apple/request';
import type { Account, Software } from '../../src/types';

vi.mock('../../src/apple/request', () => ({
  appleRequest: vi.fn(),
}));

const APP_ID = 383539271;
const VERSION_ID = '890992199';
const DEVICE_ID = '001122334455';

const account: Account = {
  email: 'test@example.com',
  password: 'password',
  appleId: 'test@example.com',
  store: '143466',
  firstName: 'Test',
  lastName: 'User',
  passwordToken: 'token',
  directoryServicesIdentifier: '987654321',
  cookies: [
    {
      name: 'mz_at0',
      value: 'session',
      path: '/',
      httpOnly: true,
      secure: true,
    },
  ],
  deviceIdentifier: DEVICE_ID,
  pod: '18',
};

const app = {
  id: APP_ID,
  bundleID: 'kr.cultureland',
  name: '컬쳐랜드',
  version: '5.1.2',
} as Software;

function response(
  status: number,
  body: string,
  extra: Partial<AppleResponse> = {},
): AppleResponse {
  return {
    status,
    statusText: '',
    headers: {},
    rawHeaders: [],
    body,
    ...extra,
  };
}

function plistResponse(
  dict: Record<string, any>,
  status = 200,
  extra: Partial<AppleResponse> = {},
): AppleResponse {
  return response(status, buildPlist(dict), extra);
}

function songItem(metadata: Record<string, any> = {}) {
  return {
    URL: 'https://iosapps.itunes.apple.com/itunes-assets/app.ipa',
    sinfs: [{ id: 0, sinf: new Uint8Array([1, 2, 3]) }],
    metadata: {
      itemId: APP_ID,
      softwareVersionExternalIdentifier: Number(VERSION_ID),
      softwareVersionBundleId: 'kr.cultureland',
      bundleShortVersionString: '5.1.2',
      bundleVersion: '512',
      ...metadata,
    },
  };
}

function lookupResponse(offers: Record<string, any>[] | undefined) {
  const results =
    offers === undefined
      ? {}
      : { [String(APP_ID)]: { bundleId: 'kr.cultureland', offers } };
  return response(200, JSON.stringify({ results }));
}

const LOOKUP_OK = lookupResponse([
  {
    version: { display: '5.1.2', externalId: Number(VERSION_ID) },
    buyParams: `productType=C&salableAdamId=${APP_ID}&appExtVrsId=${VERSION_ID}`,
  },
]);

// The response shape volumeStore returns for affected builds since 2026-09.
const EMPTY = plistResponse({});
const SUCCESS = plistResponse({ songList: [songItem()] });

function calls(): AppleRequestOptions[] {
  return vi.mocked(appleRequest).mock.calls.map((call) => call[0]);
}

function payloadOf(opts: AppleRequestOptions): Record<string, any> {
  return parsePlist(opts.body ?? '');
}

function queue(...responses: AppleResponse[]) {
  for (const r of responses) {
    vi.mocked(appleRequest).mockResolvedValueOnce(r);
  }
}

describe('apple/downloadProduct', () => {
  beforeEach(() => {
    vi.mocked(appleRequest).mockReset();
  });

  describe('response classification', () => {
    it('treats a 200 without failureType, message or items as empty', () => {
      expect(isEmptyDownloadProductResponse(200, {})).toBe(true);
      expect(
        isEmptyDownloadProductResponse(200, { status: 0, songList: [] }),
      ).toBe(true);
      expect(isEmptyDownloadProductResponse(500, {})).toBe(false);
      expect(isEmptyDownloadProductResponse(200, { failureType: '2034' })).toBe(
        false,
      );
      expect(
        isEmptyDownloadProductResponse(200, { customerMessage: 'Nope' }),
      ).toBe(false);
      expect(
        isEmptyDownloadProductResponse(200, { songList: [songItem()] }),
      ).toBe(false);
    });

    it('only treats the No Longer Available message as unavailable', () => {
      expect(
        isUnavailableDownloadProductResponse(200, {
          customerMessage: '“컬쳐랜드” No Longer Available',
        }),
      ).toBe(true);
      expect(
        isUnavailableDownloadProductResponse(200, {
          customerMessage: ' no longer available ',
        }),
      ).toBe(true);
      expect(
        isUnavailableDownloadProductResponse(200, {
          customerMessage: 'App Not Available',
        }),
      ).toBe(false);
      expect(
        isUnavailableDownloadProductResponse(200, {
          failureType: '1010',
          customerMessage: '“App” No Longer Available',
        }),
      ).toBe(false);
      expect(
        isUnavailableDownloadProductResponse(500, {
          customerMessage: '“App” No Longer Available',
        }),
      ).toBe(false);
    });
  });

  describe('lookupLatestExternalVersionId', () => {
    it('queries the enterprise catalog for the account storefront', async () => {
      queue(LOOKUP_OK);

      await expect(lookupLatestExternalVersionId(account, app)).resolves.toBe(
        VERSION_ID,
      );

      const [opts] = calls();
      expect(opts.method).toBe('GET');
      expect(opts.host).toBe('uclient-api.itunes.apple.com');
      const url = new URL(`https://${opts.host}${opts.path}`);
      expect(url.pathname).toBe('/WebObjects/MZStorePlatform.woa/wa/lookup');
      expect(Object.fromEntries(url.searchParams)).toEqual({
        version: '2',
        id: String(APP_ID),
        p: 'mdm-lockup',
        caller: 'MDM',
        platform: 'enterprisestore',
        cc: 'kr',
        l: 'en',
      });
    });

    it('sends no account cookies or DSID headers', async () => {
      queue(LOOKUP_OK);

      await lookupLatestExternalVersionId(account, app);

      const [opts] = calls();
      expect(opts.cookies).toBeUndefined();
      expect(opts.headers?.['X-Dsid']).toBeUndefined();
      expect(opts.headers?.['iCloud-DSID']).toBeUndefined();
    });

    it('falls back to the consumer catalogs', async () => {
      queue(lookupResponse(undefined), lookupResponse([]), LOOKUP_OK);

      await expect(lookupLatestExternalVersionId(account, app)).resolves.toBe(
        VERSION_ID,
      );

      const platforms = calls().map((opts) =>
        new URL(`https://${opts.host}${opts.path}`).searchParams.get(
          'platform',
        ),
      );
      expect(platforms).toEqual(['enterprisestore', 'iphone', 'ipad']);
    });

    it('reads appExtVrsId from buyParams when externalId is missing', async () => {
      queue(
        lookupResponse([
          {
            version: { externalId: '' },
            buyParams: `productType=C&appExtVrsId=${VERSION_ID}`,
          },
        ]),
      );

      await expect(lookupLatestExternalVersionId(account, app)).resolves.toBe(
        VERSION_ID,
      );
    });

    it('fails when no catalog lists the app', async () => {
      queue(
        lookupResponse(undefined),
        lookupResponse(undefined),
        lookupResponse(undefined),
      );

      await expect(lookupLatestExternalVersionId(account, app)).rejects.toThrow(
        i18n.t('errors.download.versionLookupFailed'),
      );
      expect(calls()).toHaveLength(3);
    });

    it('stops on an HTTP error', async () => {
      queue(response(503, 'Service Unavailable'));

      await expect(lookupLatestExternalVersionId(account, app)).rejects.toThrow(
        i18n.t('errors.download.versionLookupFailed'),
      );
      expect(calls()).toHaveLength(1);
    });

    it('rejects a non-numeric version id', async () => {
      queue(lookupResponse([{ version: { externalId: 'abc' } }]));

      await expect(lookupLatestExternalVersionId(account, app)).rejects.toThrow(
        i18n.t('errors.download.versionLookupFailed'),
      );
    });

    it('fails without a request for an unknown storefront', async () => {
      await expect(
        lookupLatestExternalVersionId({ ...account, store: '999999' }, app),
      ).rejects.toBeInstanceOf(DownloadError);
      expect(calls()).toHaveLength(0);
    });
  });

  describe('sendDownloadProduct', () => {
    it('returns a volumeStore success without any fallback', async () => {
      queue(SUCCESS);

      const { dict } = await sendDownloadProduct(account, app);

      expect(dict.songList).toHaveLength(1);
      expect(calls()).toHaveLength(1);
      const [opts] = calls();
      expect(opts.host).toBe('p18-buy.itunes.apple.com');
      expect(opts.path).toBe(
        `/WebObjects/MZFinance.woa/wa/volumeStoreDownloadProduct?guid=${DEVICE_ID}`,
      );
      expect(opts.headers?.['X-Dsid']).toBe('987654321');
      expect(opts.headers?.['iCloud-DSID']).toBe('987654321');
      expect(payloadOf(opts)).toEqual({
        creditDisplay: '',
        guid: DEVICE_ID,
        salableAdamId: APP_ID,
        serialNumber: '0',
      });
    });

    it('pins the latest version and retries redownload on an empty response', async () => {
      queue(EMPTY, LOOKUP_OK, SUCCESS);

      const { dict } = await sendDownloadProduct(account, app);

      expect(dict.songList).toHaveLength(1);
      const [, lookup, redownload] = calls();
      expect(calls()).toHaveLength(3);
      expect(lookup.host).toBe('uclient-api.itunes.apple.com');
      expect(redownload.host).toBe('downloaddispatch.itunes.apple.com');
      expect(redownload.path).toBe(`/r/redownload?guid=${DEVICE_ID}`);
      const payload = payloadOf(redownload);
      expect(payload.appExtVrsId).toBe(VERSION_ID);
      expect(payload.externalVersionId).toBeUndefined();
      expect(payload.serialNumber).toBe('0');
    });

    it('uses the requested version instead of a lookup', async () => {
      queue(EMPTY, SUCCESS);

      await sendDownloadProduct(account, app, '123');

      const [primary, redownload] = calls();
      expect(calls()).toHaveLength(2);
      expect(payloadOf(primary).externalVersionId).toBe('123');
      expect(payloadOf(redownload).appExtVrsId).toBe('123');
      expect(payloadOf(redownload).externalVersionId).toBeUndefined();
    });

    it('falls back to updateProduct when redownload answers an empty HTTP 500', async () => {
      queue(EMPTY, LOOKUP_OK, response(500, ''), SUCCESS);

      const { dict } = await sendDownloadProduct(account, app);

      expect(dict.songList[0].metadata.softwareVersionBundleId).toBe(
        'kr.cultureland',
      );
      const [, , redownload, update] = calls();
      expect(update.host).toBe('downloaddispatch.itunes.apple.com');
      expect(update.path).toBe(`/up/updateProduct?guid=${DEVICE_ID}`);
      expect(update.body).toBe(redownload.body);
    });

    it('treats a markup-only HTTP 500 as empty', async () => {
      queue(
        EMPTY,
        LOOKUP_OK,
        response(500, '<html><body> </body></html>'),
        SUCCESS,
      );

      await sendDownloadProduct(account, app);

      expect(calls()[3].path).toBe(`/up/updateProduct?guid=${DEVICE_ID}`);
    });

    it('falls back to updateProduct when redownload says No Longer Available', async () => {
      queue(
        EMPTY,
        LOOKUP_OK,
        plistResponse({ customerMessage: '“컬쳐랜드” No Longer Available' }),
        SUCCESS,
      );

      await sendDownloadProduct(account, app);

      expect(calls()).toHaveLength(4);
      expect(calls()[3].path).toBe(`/up/updateProduct?guid=${DEVICE_ID}`);
    });

    it('falls back to updateProduct when redownload is empty too', async () => {
      queue(EMPTY, LOOKUP_OK, EMPTY, SUCCESS);

      await sendDownloadProduct(account, app);

      expect(calls()).toHaveLength(4);
      expect(calls()[3].path).toBe(`/up/updateProduct?guid=${DEVICE_ID}`);
    });

    it.each([
      ['item id', { itemId: 1 }],
      ['version', { softwareVersionExternalIdentifier: 1 }],
      ['bundle id', { softwareVersionBundleId: 'com.example.other' }],
      ['missing bundle id', { softwareVersionBundleId: undefined }],
    ])(
      'rejects an updateProduct item with a different %s',
      async (_, metadata) => {
        queue(
          EMPTY,
          LOOKUP_OK,
          response(500, ''),
          plistResponse({ songList: [songItem(metadata)] }),
        );

        await expect(sendDownloadProduct(account, app)).rejects.toThrow(
          i18n.t('errors.download.fallbackMismatch'),
        );
      },
    );

    it('rejects an updateProduct response with several items', async () => {
      queue(
        EMPTY,
        LOOKUP_OK,
        response(500, ''),
        plistResponse({ songList: [songItem(), songItem()] }),
      );

      await expect(sendDownloadProduct(account, app)).rejects.toThrow(
        i18n.t('errors.download.fallbackMismatch'),
      );
    });

    it('surfaces an updateProduct customer message', async () => {
      queue(
        EMPTY,
        LOOKUP_OK,
        response(500, ''),
        plistResponse({ customerMessage: '“컬쳐랜드” No Longer Available' }),
      );

      await expect(sendDownloadProduct(account, app)).rejects.toThrow(
        '“컬쳐랜드” No Longer Available',
      );
    });

    it('returns an updateProduct failureType for the caller to map', async () => {
      queue(
        EMPTY,
        LOOKUP_OK,
        response(500, ''),
        plistResponse({ failureType: '2034' }),
      );

      const { dict } = await sendDownloadProduct(account, app);

      expect(dict.failureType).toBe('2034');
    });

    it('does not retry a redownload HTTP 500 that has a body', async () => {
      queue(EMPTY, LOOKUP_OK, response(500, 'Service maintenance'));

      await expect(sendDownloadProduct(account, app)).rejects.toThrow(
        i18n.t('errors.download.unexpectedResponse', { status: 500 }),
      );
      expect(calls()).toHaveLength(3);
    });

    it('pins the redownload that follows a 5002', async () => {
      queue(plistResponse({ failureType: '5002' }), LOOKUP_OK, SUCCESS);

      await sendDownloadProduct(account, app);

      expect(payloadOf(calls()[2]).appExtVrsId).toBe(VERSION_ID);
    });

    it('keeps the unpinned redownload after a 5002 when the lookup fails', async () => {
      queue(plistResponse({ failureType: '5002' }), response(503, ''), SUCCESS);

      const { dict } = await sendDownloadProduct(account, app);

      expect(dict.songList).toHaveLength(1);
      const redownload = calls()[2];
      expect(redownload.path).toBe(`/r/redownload?guid=${DEVICE_ID}`);
      expect(payloadOf(redownload).appExtVrsId).toBeUndefined();
    });

    it('never sends an unpinned dispatch request for an empty response', async () => {
      queue(EMPTY, response(503, ''));

      await expect(sendDownloadProduct(account, app)).rejects.toThrow(
        i18n.t('errors.download.versionLookupFailed'),
      );
      expect(
        calls().some(
          (opts) => opts.host === 'downloaddispatch.itunes.apple.com',
        ),
      ).toBe(false);
    });

    it.each([
      ['2034', { failureType: '2034' }],
      ['9610', { failureType: '9610' }],
      ['a message', { customerMessage: 'App Not Available' }],
    ])('returns %s from volumeStore without a fallback', async (_, dict) => {
      queue(plistResponse(dict));

      const result = await sendDownloadProduct(account, app);

      expect(result.dict).toEqual(dict);
      expect(calls()).toHaveLength(1);
    });

    it('follows a relative redirect and threads cookies through every hop', async () => {
      queue(
        response(302, '', {
          headers: { location: '/WebObjects/MZFinance.woa/wa/moved?guid=x' },
          rawHeaders: [
            ['Set-Cookie', 'hop1=a; Path=/; Domain=.itunes.apple.com'],
          ],
        }),
        plistResponse({}, 200, {
          rawHeaders: [
            ['Set-Cookie', 'hop2=b; Path=/; Domain=.itunes.apple.com'],
          ],
        }),
        LOOKUP_OK,
        SUCCESS,
      );

      const { updatedCookies } = await sendDownloadProduct(account, app);

      const [first, moved, , redownload] = calls();
      expect(moved.host).toBe(first.host);
      expect(moved.path).toBe('/WebObjects/MZFinance.woa/wa/moved?guid=x');
      expect(moved.cookies?.map((c) => c.name)).toContain('hop1');
      expect(redownload.cookies?.map((c) => c.name)).toEqual(
        expect.arrayContaining(['mz_at0', 'hop1', 'hop2']),
      );
      expect(updatedCookies.map((c) => c.name)).toEqual(
        expect.arrayContaining(['mz_at0', 'hop1', 'hop2']),
      );
    });

    it('reports a non-plist volumeStore response with its HTTP status', async () => {
      queue(response(503, '<html><body>Service Unavailable</body></html>'));

      await expect(sendDownloadProduct(account, app)).rejects.toThrow(
        i18n.t('errors.download.unexpectedResponse', { status: 503 }),
      );
    });
  });
});
