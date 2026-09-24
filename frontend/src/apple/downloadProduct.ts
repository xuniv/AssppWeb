import { appleRequest } from "./request";
import { buildPlist, parsePlist } from "./plist";
import { extractAndMergeCookies } from "./cookies";
import {
  RETRYABLE_FAILURE_TYPE,
  VERSION_LOOKUP_CATALOGS,
  VERSION_LOOKUP_HOST,
  redownloadEndpoint,
  storeIdToCountry,
  updateProductEndpoint,
  volumeStoreEndpoint,
} from "./config";
import i18n from "../i18n";
import type { StoreDownloadEndpoint } from "./config";
import type { Account, Cookie, Software } from "../types";

export class DownloadError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "DownloadError";
  }
}

interface ProductResponse {
  status: number;
  body: string;
  // Undefined when the body is not a property list.
  dict?: Record<string, any>;
}

export interface DownloadProductResult {
  dict: Record<string, any>;
  updatedCookies: Cookie[];
}

function failureTypeOf(dict: Record<string, any>): string {
  return String(dict.failureType ?? "");
}

function hasItems(dict: Record<string, any>): boolean {
  return Array.isArray(dict.songList) && dict.songList.length > 0;
}

// volumeStore answers some requests with HTTP 200 and nothing in it: no
// failureType, no customerMessage and no songList.
export function isEmptyDownloadProductResponse(
  status: number,
  dict: Record<string, any>,
): boolean {
  return (
    status === 200 &&
    failureTypeOf(dict) === "" &&
    String(dict.customerMessage ?? "") === "" &&
    !hasItems(dict)
  );
}

// Limit recovery to the observed availability response ("“App” No Longer
// Available"); other customer messages and structured failures keep their
// normal error handling.
export function isUnavailableDownloadProductResponse(
  status: number,
  dict: Record<string, any>,
): boolean {
  const message = String(dict.customerMessage ?? "")
    .trim()
    .toLowerCase();
  return (
    status === 200 &&
    failureTypeOf(dict) === "" &&
    !hasItems(dict) &&
    (message === "no longer available" ||
      message.endsWith(" no longer available"))
  );
}

function looksLikePlist(body: string): boolean {
  const trimmed = body.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("bplist")) return true;
  const lower = trimmed.toLowerCase();
  return ["<?xml", "<plist", "<dict", "<key"].some((marker) =>
    lower.includes(marker),
  );
}

// redownload can answer HTTP 500 with an empty (or markup-only) body when it
// will not serve a build that updateProduct still serves.
function isEmptyServerError(response: ProductResponse): boolean {
  return (
    response.status === 500 &&
    !looksLikePlist(response.body) &&
    response.body.replace(/<[^>]*>/g, " ").trim() === ""
  );
}

function needsDispatchFallback(response: ProductResponse): boolean {
  const { status, dict } = response;
  if (!dict) return false;
  return (
    isEmptyDownloadProductResponse(status, dict) ||
    isUnavailableDownloadProductResponse(status, dict)
  );
}

function decodePlist(body: string): Record<string, any> | undefined {
  if (!looksLikePlist(body)) return undefined;
  try {
    const dict = parsePlist(body);
    return dict && typeof dict === "object" && !Array.isArray(dict)
      ? (dict as Record<string, any>)
      : undefined;
  } catch {
    return undefined;
  }
}

function requireDict(response: ProductResponse): Record<string, any> {
  if (!response.dict) {
    throw new DownloadError(
      i18n.t("errors.download.unexpectedResponse", {
        status: response.status,
      }),
    );
  }
  return response.dict;
}

// Resolves the latest external version id of an iOS app from the public MDM
// catalog, so dispatch fallbacks can be pinned: an unpinned redownload can
// fail or return another platform's build. No cookies or DSID are sent.
export async function lookupLatestExternalVersionId(
  account: Account,
  app: Software,
): Promise<string> {
  const lookupFailed = () =>
    new DownloadError(i18n.t("errors.download.versionLookupFailed"));

  const country = storeIdToCountry(account.store);
  if (!country) throw lookupFailed();

  for (const catalog of VERSION_LOOKUP_CATALOGS) {
    const params = new URLSearchParams({
      version: "2",
      id: String(app.id),
      p: "mdm-lockup",
      caller: "MDM",
      platform: catalog,
      cc: country.toLowerCase(),
      l: "en",
    });

    const response = await appleRequest({
      method: "GET",
      host: VERSION_LOOKUP_HOST,
      path: `/WebObjects/MZStorePlatform.woa/wa/lookup?${params}`,
    });
    if (response.status !== 200) throw lookupFailed();

    let data: any;
    try {
      data = JSON.parse(response.body);
    } catch {
      throw lookupFailed();
    }

    const offer = data?.results?.[String(app.id)]?.offers?.[0];
    if (!offer) continue;

    let versionId = String(offer.version?.externalId ?? "");
    if (!versionId && typeof offer.buyParams === "string") {
      versionId =
        new URLSearchParams(offer.buyParams).get("appExtVrsId") ?? "";
    }
    if (!/^[1-9]\d*$/.test(versionId)) throw lookupFailed();

    return versionId;
  }

  throw lookupFailed();
}

// updateProduct is only reached through a pinned fallback. Make sure it served
// the requested app and version before accepting it.
function validateUpdateProduct(
  response: ProductResponse,
  app: Software,
  versionId: string,
): Record<string, any> {
  const dict = requireDict(response);

  // Structured failures (2034, 9610, ...) are mapped by the caller.
  if (failureTypeOf(dict)) return dict;

  const customerMessage = String(dict.customerMessage ?? "");
  if (customerMessage) throw new DownloadError(customerMessage);

  if (response.status !== 200) {
    throw new DownloadError(
      i18n.t("errors.download.unexpectedResponse", {
        status: response.status,
      }),
    );
  }

  if (!hasItems(dict)) {
    throw new DownloadError(i18n.t("errors.download.noItems"));
  }

  const mismatch = () =>
    new DownloadError(i18n.t("errors.download.fallbackMismatch"));
  if (dict.songList.length !== 1) throw mismatch();

  const metadata = (dict.songList[0]?.metadata ?? {}) as Record<string, any>;
  if (
    String(metadata.itemId) !== String(app.id) ||
    String(metadata.softwareVersionExternalIdentifier) !== versionId
  ) {
    throw mismatch();
  }

  const bundleId = metadata.softwareVersionBundleId;
  if (
    typeof bundleId !== "string" ||
    !bundleId ||
    (app.bundleID && bundleId !== app.bundleID)
  ) {
    throw mismatch();
  }

  return dict;
}

// Shared download-product protocol for downloads, version lists and version
// metadata. Tries volumeStore first; when it answers 5002, an empty response
// or "No Longer Available", retries through the download dispatch endpoints
// with the version pinned (redownload, then updateProduct). The returned dict
// is not interpreted further: callers map failureType and songList themselves.
export async function sendDownloadProduct(
  account: Account,
  app: Software,
  externalVersionId?: string,
): Promise<DownloadProductResult> {
  const deviceId = account.deviceIdentifier;
  let cookies = [...account.cookies];

  const headers: Record<string, string> = {
    "Content-Type": "application/x-apple-plist",
    "iCloud-DSID": account.directoryServicesIdentifier,
    "X-Dsid": account.directoryServicesIdentifier,
  };

  async function post(
    endpoint: StoreDownloadEndpoint,
    versionId: string | undefined,
  ): Promise<ProductResponse> {
    const payload: Record<string, any> = {
      creditDisplay: "",
      guid: deviceId,
      salableAdamId: app.id,
      serialNumber: "0",
    };
    if (versionId) {
      payload[endpoint.externalVersionIdKey] = versionId;
    }
    const body = buildPlist(payload);

    let host = endpoint.host;
    let path = endpoint.path;
    for (let redirectAttempt = 0; redirectAttempt <= 3; redirectAttempt++) {
      const response = await appleRequest({
        method: "POST",
        host,
        path,
        headers,
        body,
        cookies,
      });

      cookies = extractAndMergeCookies(response.rawHeaders, cookies);

      if (response.status === 302) {
        const location = response.headers["location"];
        if (!location) {
          throw new DownloadError(i18n.t("errors.download.redirectLocation"));
        }
        const url = new URL(location, `https://${host}${path}`);
        host = url.hostname;
        path = url.pathname + url.search;
        continue;
      }

      return {
        status: response.status,
        body: response.body,
        dict: decodePlist(response.body),
      };
    }

    throw new DownloadError(i18n.t("errors.download.tooManyRedirects"));
  }

  const primary = await post(
    volumeStoreEndpoint(account.pod, deviceId),
    externalVersionId,
  );
  const primaryDict = requireDict(primary);
  const is5002 = failureTypeOf(primaryDict) === RETRYABLE_FAILURE_TYPE;
  if (!is5002 && !needsDispatchFallback(primary)) {
    return { dict: primaryDict, updatedCookies: cookies };
  }

  // Pin the version before falling back. For 5002, keep the legacy unpinned
  // redownload when the catalog lookup is unavailable.
  let versionId = externalVersionId || undefined;
  if (!versionId) {
    try {
      versionId = await lookupLatestExternalVersionId(account, app);
    } catch (e) {
      if (!is5002) throw e;
    }
  }

  const redownload = await post(redownloadEndpoint(deviceId), versionId);
  if (
    versionId &&
    (isEmptyServerError(redownload) || needsDispatchFallback(redownload))
  ) {
    const update = await post(updateProductEndpoint(deviceId), versionId);
    return {
      dict: validateUpdateProduct(update, app, versionId),
      updatedCookies: cookies,
    };
  }

  return { dict: requireDict(redownload), updatedCookies: cookies };
}
