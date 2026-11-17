import { createHash } from 'crypto';
import { timingSafeEqual } from 'crypto';
import path from 'path';
import os from 'os';

export const config = {
  port: parseInt(process.env.PORT || '8080'),
  dataDir: process.env.DATA_DIR || './data',
  publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
  disableHttpsRedirect: process.env.UNSAFE_DANGEROUSLY_DISABLE_HTTPS_REDIRECT === 'true',
  // Auto-cleanup: 0 disables
  autoCleanupDays: parseInt(process.env.AUTO_CLEANUP_DAYS || '0', 10) || 0,
  autoCleanupMaxMB: parseInt(process.env.AUTO_CLEANUP_MAX_MB || '0', 10) || 0,
  // Max download file size in MB (0 disables)
  maxDownloadMB: parseInt(process.env.MAX_DOWNLOAD_MB || '0', 10) || 0,
  // Build info (injected via Docker build args)
  buildCommit: process.env.BUILD_COMMIT || 'unknown',
  buildDate: process.env.BUILD_DATE || 'unknown',
  // Access password protection (empty = disabled)
  accessPassword: process.env.ACCESS_PASSWORD || '',
  // Bundled server execution is available only after each browser opts in.
  serverStoreRuntimeEnabled: process.env.SERVER_STORE_RUNTIME_ENABLED !== 'false',
  serverStoreRuntimePath:
    process.env.SERVER_STORE_RUNTIME_PATH ||
    path.resolve(import.meta.dirname, '../server-runtime/asspp-runtime-native'),
  serverStoreRuntimeAssets:
    process.env.SERVER_STORE_RUNTIME_ASSETS || path.resolve(import.meta.dirname, '../server-runtime/assets'),
  serverUnfairplayEnabled: process.env.SERVER_UNFAIRPLAY_ENABLED !== 'false',
  serverUnfairplayPath:
    process.env.SERVER_UNFAIRPLAY_PATH || path.resolve(import.meta.dirname, '../server-runtime/asspp-unfairplay'),
  unfairplayTempDir: process.env.UNFAIRPLAY_TEMP_DIR || path.join(os.tmpdir(), 'asspp-unfairplay'),
};

export const UNFAIRPLAY_MAX_IPA_BYTES = 2 * 1024 * 1024 * 1024;
export const UNFAIRPLAY_MAX_OUTPUT_BYTES = 4 * 1024 * 1024 * 1024;
export const UNFAIRPLAY_MAX_MODELS = 256;
export const UNFAIRPLAY_MODEL_SIZES = [4176, 4184, 8708] as const;
export const UNFAIRPLAY_TIMEOUT_MS = 10 * 60 * 1000;

export const SERVER_RUNTIME_MAX_BYTES = 8 * 1024 * 1024;
export const SERVER_RUNTIME_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
export const SERVER_RUNTIME_CONCURRENCY = Math.max(
  1,
  Math.min(4, parseInt(process.env.SERVER_STORE_RUNTIME_CONCURRENCY || '1', 10) || 1),
);
export const SERVER_RUNTIME_TIMEOUT_MS = Math.max(
  30_000,
  Math.min(300_000, parseInt(process.env.SERVER_STORE_RUNTIME_TIMEOUT_MS || '300000', 10) || 300_000),
);

export const accessPasswordHash = config.accessPassword
  ? createHash('sha256').update(config.accessPassword).digest('hex')
  : '';

/** Timing-safe comparison of a client-supplied token against the precomputed hash. */
export function verifyAccessToken(token: string): boolean {
  const expected = Buffer.from(accessPasswordHash, 'utf8');
  const actual = Buffer.from(token, 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export const MAX_DOWNLOAD_SIZE = 8 * 1024 * 1024 * 1024; // 8 GB
export const DOWNLOAD_TIMEOUT_MS = 8 * 60 * 60 * 1000; // 8 hours
export const BAG_TIMEOUT_MS = 15_000; // 15 seconds
export const BAG_MAX_BYTES = 1024 * 1024; // 1 MB
export const MIN_ACCOUNT_HASH_LENGTH = 8;

// Chunked download settings
export const DOWNLOAD_THREADS = Math.max(1, Math.min(32, parseInt(process.env.DOWNLOAD_THREADS || '8', 10) || 8));
export const CHUNK_RETRY_COUNT = 3;
export const CHUNK_RETRY_DELAY_MS = 2000;
