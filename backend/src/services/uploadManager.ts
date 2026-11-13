import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import type { IncomingMessage } from 'http';
import { open as openZip } from 'yauzl-promise';
import bplistParser from 'bplist-parser';
import plist from 'plist';
import { config, MAX_DOWNLOAD_SIZE } from '../config.js';
import type { Software } from '../types/index.js';

export interface UploadedPackage {
  id: string;
  software: Pick<Software, 'bundleID' | 'name' | 'version'>;
  fileSize: number;
  createdAt: string;
}

export class UploadError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const uploadsDir = path.resolve(config.dataDir, 'uploads');
const uploads = new Map<string, UploadedPackage>();
const MAX_INFO_BYTES = 1024 * 1024;
const MAX_ENTRIES = 100_000;

// Uploads are deliberately temporary; no IPA metadata or file survives restart.
fs.rmSync(uploadsDir, { recursive: true, force: true });
fs.mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });

export function getUpload(id: string): UploadedPackage | undefined {
  return uploads.get(id);
}

export function getUploadPath(id: string): string | undefined {
  return uploads.has(id) ? path.join(uploadsDir, `${id}.ipa`) : undefined;
}

export function listUploads(): UploadedPackage[] {
  cleanupUploads();
  return [...uploads.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function deleteUpload(id: string): boolean {
  const filePath = getUploadPath(id);
  if (!filePath) return false;
  fs.rmSync(filePath, { force: true });
  return uploads.delete(id);
}

export function cleanupUploads(): void {
  const cutoff = Date.now() - config.autoCleanupDays * 86_400_000;
  const oldest = [...uploads.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let total = oldest.reduce((sum, item) => sum + item.fileSize, 0);
  for (const item of oldest) {
    const expired = config.autoCleanupDays > 0 && Date.parse(item.createdAt) < cutoff;
    const overLimit = config.autoCleanupMaxMB > 0 && total > config.autoCleanupMaxMB * 1024 * 1024;
    if (expired || overLimit) {
      deleteUpload(item.id);
      total -= item.fileSize;
    }
  }
}

setInterval(cleanupUploads, 60 * 60 * 1000).unref();

function infoString(info: Record<string, unknown>, key: string, maxLength = 255): string | undefined {
  const value = info[key];
  return typeof value === 'string' && value.trim() && value.length <= maxLength && !/[\x00-\x1f]/.test(value)
    ? value
    : undefined;
}

async function readSoftware(filePath: string): Promise<UploadedPackage['software']> {
  const zip = await openZip(filePath);
  try {
    let info: Record<string, unknown> | undefined;
    let entries = 0;
    for await (const entry of zip) {
      if (++entries > MAX_ENTRIES) throw new UploadError(400, 'IPA contains too many entries');
      // Only the top-level app counts, not a Watch app or embedded extension.
      if (!/^Payload\/[^/]+\.app\/Info\.plist$/.test(entry.filename)) continue;
      if (info) throw new UploadError(400, 'IPA must contain exactly one main app');
      const fileType = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (entry.isEncrypted() || fileType === 0o120000 || entry.uncompressedSize > MAX_INFO_BYTES) {
        throw new UploadError(400, 'Invalid or oversized app Info.plist');
      }
      const stream = await entry.openReadStream();
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > MAX_INFO_BYTES) {
          stream.destroy();
          throw new UploadError(400, 'App Info.plist is too large');
        }
        chunks.push(chunk);
      }
      const data = Buffer.concat(chunks);
      const parsed =
        data.subarray(0, 8).toString() === 'bplist00'
          ? bplistParser.parseBuffer(data)[0]
          : plist.parse(data.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new UploadError(400, 'Invalid app Info.plist');
      }
      info = parsed as Record<string, unknown>;
    }
    if (!info) throw new UploadError(400, 'IPA is missing Payload/App.app/Info.plist');
    const bundleID = infoString(info, 'CFBundleIdentifier');
    const version = infoString(info, 'CFBundleVersion', 128) ?? infoString(info, 'CFBundleShortVersionString', 128);
    if (!bundleID || !/^[A-Za-z0-9.-]+$/.test(bundleID) || !version) {
      throw new UploadError(400, 'IPA is missing a valid bundle identifier or version');
    }
    const name = infoString(info, 'CFBundleDisplayName') ?? infoString(info, 'CFBundleName') ?? bundleID;
    return { bundleID, version, name };
  } finally {
    await zip.close();
  }
}

export async function receiveUpload(req: IncomingMessage): Promise<UploadedPackage> {
  cleanupUploads();
  const maxSize = Math.min(
    MAX_DOWNLOAD_SIZE,
    config.maxDownloadMB > 0 ? config.maxDownloadMB * 1024 * 1024 : MAX_DOWNLOAD_SIZE,
    config.autoCleanupMaxMB > 0 ? config.autoCleanupMaxMB * 1024 * 1024 : MAX_DOWNLOAD_SIZE,
  );
  const length = Number(req.headers['content-length']);
  if (Number.isFinite(length) && length > maxSize) throw new UploadError(413, 'IPA exceeds the configured size limit');
  const id = randomUUID();
  const stagingPath = path.join(uploadsDir, `${id}.part`);
  const finalPath = path.join(uploadsDir, `${id}.ipa`);
  let size = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      callback(size > maxSize ? new UploadError(413, 'IPA exceeds the configured size limit') : null, chunk);
    },
  });
  const abort = () => limiter.destroy(new UploadError(400, 'Upload interrupted'));
  const onError = () => abort();
  req.once('aborted', abort);
  req.once('error', onError);
  // Keep the request outside pipeline so size errors can still return HTTP 413.
  req.pipe(limiter);
  try {
    await pipeline(limiter, fs.createWriteStream(stagingPath, { flags: 'wx', mode: 0o600 }));
    let software: UploadedPackage['software'];
    try {
      software = await readSoftware(stagingPath);
    } catch (err) {
      if (err instanceof UploadError) throw err;
      throw new UploadError(400, 'Invalid IPA archive or app Info.plist');
    }
    if (req.socket.destroyed) throw new UploadError(400, 'Upload interrupted');
    const item: UploadedPackage = { id, software, fileSize: size, createdAt: new Date().toISOString() };
    await fs.promises.rename(stagingPath, finalPath);
    uploads.set(id, item);
    cleanupUploads();
    return item;
  } finally {
    req.unpipe(limiter);
    req.off('aborted', abort);
    req.off('error', onError);
    req.resume();
    await fs.promises.rm(stagingPath, { force: true });
  }
}
