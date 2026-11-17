import { authHeaders } from './client';
import { serverRuntimeTransportAllowed } from '../utils/runtimeTransport';

export type UnfairPlayOperation =
  | 'model_inspect'
  | 'decrypt'
  | 'verify'
  | 'doctor'
  | 'strip_account_data'
  | 'convert_ipa_macos';
export interface UnfairPlayResult {
  ipa?: Blob;
  report: Blob;
  summary: Record<string, unknown>;
  dispose?: () => Promise<void>;
}
export interface UnfairPlayRequest {
  operation: UnfairPlayOperation;
  input?: Blob;
  source?: { kind: 'package' | 'upload'; id: string; accountHash?: string };
  models: Blob[];
  stripAccountData: boolean;
  signal: AbortSignal;
  onProgress?: (progress: { stage: string }) => void;
}

// Reports are intentionally summaries, never upstream evidence. In particular,
// enrollment/key fingerprints, selectors, paths and identities are excluded.
export function safeUnfairPlaySummary(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of ['plaintextVerified', 'accountDataStripped', 'ready', 'registryCompatible']) {
    if (typeof input[key] === 'boolean') output[key] = input[key];
  }
  for (const key of [
    'encryptedImages',
    'decryptedPages',
    'removedLicenseFiles',
    'removedMetadataFields',
    'modelCount',
    'convertedRecords',
    'convertedReplicas',
  ]) {
    if (Number.isSafeInteger(input[key]) && Number(input[key]) >= 0) output[key] = input[key];
  }
  if (
    Array.isArray(input.modelVersions) &&
    input.modelVersions.length <= 256 &&
    input.modelVersions.every((version) => [1, 2, 3].includes(version))
  )
    output.modelVersions = input.modelVersions;
  else if (
    Array.isArray(input.models) &&
    input.models.length <= 256 &&
    input.models.every((model) => model && typeof model === 'object' && [1, 2, 3].includes(model.version))
  ) {
    output.modelVersions = input.models.map((model) => model.version);
    output.modelCount = input.models.length;
  }
  return output;
}
export function unfairPlaySummaryReport(summary: Record<string, unknown>): Blob {
  return new Blob([JSON.stringify(safeUnfairPlaySummary(summary), null, 2)], { type: 'application/json' });
}

export async function runServerUnfairPlay(request: UnfairPlayRequest): Promise<UnfairPlayResult> {
  if (!serverRuntimeTransportAllowed()) throw new Error('https_required');
  const body = new FormData();
  if (request.input) body.append('ipa', request.input, 'input.ipa');
  else if (request.source) body.append('source', JSON.stringify(request.source));
  if (request.operation !== 'strip_account_data')
    for (const model of request.models) body.append('models', model, 'multi.bin');
  if (request.operation === 'decrypt') body.append('stripAccountData', String(request.stripAccountData));
  const response = await fetch(`/api/unfairplay/${request.operation}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'X-Asspp-Unfairplay-Consent': 'model-v1' },
    body,
    signal: request.signal,
    cache: 'no-store',
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`unfairplay_http_${response.status}`);
  if (['decrypt', 'strip_account_data', 'convert_ipa_macos'].includes(request.operation)) {
    const encoded = response.headers.get('X-Asspp-Unfairplay-Summary');
    let summary: Record<string, unknown> = {};
    if (encoded) {
      if (encoded.length > 32768) throw new Error('invalid_report');
      const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
      summary = safeUnfairPlaySummary(
        JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (byte) => byte.charCodeAt(0)))),
      );
    }
    return {
      ipa: await response.blob(),
      summary,
      report: unfairPlaySummaryReport(summary),
    };
  }
  const value = await response.json();
  if (value.ok !== true || !value.value || typeof value.value !== 'object') throw new Error('invalid_report');
  const summary = safeUnfairPlaySummary(value.value);
  return { summary, report: unfairPlaySummaryReport(summary) };
}
