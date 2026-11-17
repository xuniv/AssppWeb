import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Readable, Transform, Writable } from 'stream';
import { pipeline } from 'stream/promises';
import type { IncomingMessage } from 'http';
import Busboy from 'busboy';
import { open as openZip } from 'yauzl-promise';
import {
  config,
  UNFAIRPLAY_MAX_IPA_BYTES,
  UNFAIRPLAY_MAX_MODELS,
  UNFAIRPLAY_MAX_OUTPUT_BYTES,
  UNFAIRPLAY_MODEL_SIZES,
  UNFAIRPLAY_TIMEOUT_MS,
} from '../config.js';

export const unfairplayOperations = [
  'model_inspect',
  'doctor',
  'verify',
  'decrypt',
  'strip_account_data',
  'convert_ipa_macos',
] as const;
export type UnfairplayOperation = (typeof unfairplayOperations)[number];
export type UnfairplaySummary = Record<string, boolean | number | number[]>;
export type UnfairplaySource = { kind: 'package' | 'upload'; id: string; accountHash?: string };
export type SourceResolver = (source: UnfairplaySource) => string;

export class UnfairplayError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
  }
}

interface Options {
  enabled: boolean;
  binaryPath: string;
  tempDir: string;
  maxIpaBytes: number;
  maxOutputBytes: number;
  maxModels: number;
  concurrency: number;
  timeoutMs: number;
  maxEntryBytes: number;
  maxExpandedBytes: number;
  minimumFreeBytes: number;
}

const modelSizes: readonly number[] = UNFAIRPLAY_MODEL_SIZES;
const maxModelBytes = Math.max(...modelSizes);
const maxProtocolBytes = 4 * 1024 * 1024;
const outputOperations = new Set<UnfairplayOperation>(['decrypt', 'strip_account_data', 'convert_ipa_macos']);
const modelOperations = new Set<UnfairplayOperation>(['model_inspect', 'verify', 'decrypt', 'convert_ipa_macos']);
const nativeErrors: Record<string, number> = {
  invalid_request: 400,
  invalid_input: 400,
  invalid_model: 400,
  output_exists: 409,
  unsupported_operation: 400,
  processing_failed: 422,
  output_limit: 413,
  canceled: 499,
};
const countFields = new Set([
  'encryptedImages',
  'decryptedPages',
  'removedLicenseFiles',
  'removedMetadataFields',
  'modelCount',
  'convertedRecords',
  'convertedReplicas',
]);
const boolFields = new Set(['plaintextVerified', 'accountDataStripped', 'ready', 'registryCompatible']);

function failure(error: unknown, code = 'processing_failed', status = 500): UnfairplayError {
  return error instanceof UnfairplayError ? error : new UnfairplayError(code, status);
}

function safeSummary(value: unknown): UnfairplaySummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UnfairplayError('processing_failed', 502);
  const summary: UnfairplaySummary = {};
  for (const [key, entry] of Object.entries(value)) {
    if (countFields.has(key)) {
      if (!Number.isSafeInteger(entry) || entry < 0) throw new UnfairplayError('processing_failed', 502);
      summary[key] = entry;
    } else if (boolFields.has(key)) {
      if (typeof entry !== 'boolean') throw new UnfairplayError('processing_failed', 502);
      summary[key] = entry;
    } else if (key === 'modelVersions') {
      if (!Array.isArray(entry) || entry.length > UNFAIRPLAY_MAX_MODELS || entry.some((v) => ![1, 2, 3].includes(v))) {
        throw new UnfairplayError('processing_failed', 502);
      }
      summary[key] = entry;
    }
    // Local C ABI paths and any private diagnostics never cross the HTTP boundary.
  }
  if (Object.keys(summary).length === 0) throw new UnfairplayError('processing_failed', 502);
  return summary;
}

function parseSource(text: string): UnfairplaySource {
  try {
    const value = JSON.parse(text);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !['package', 'upload'].includes(value.kind) ||
      typeof value.id !== 'string' ||
      !/^[a-zA-Z0-9-]{1,80}$/.test(value.id) ||
      Object.keys(value).some((key) => !['kind', 'id', 'accountHash'].includes(key)) ||
      (value.accountHash !== undefined && (typeof value.accountHash !== 'string' || value.accountHash.length > 128))
    ) {
      throw new Error();
    }
    return value;
  } catch {
    throw new UnfairplayError('invalid_request', 400);
  }
}

// No accounts or models are retained on this object. A slot covers upload,
// processing and result streaming, so there is no queued credential-bearing work.
export class UnfairplayService {
  private active = 0;
  private initialized = false;

  constructor(
    readonly options: Options = {
      enabled: config.serverUnfairplayEnabled,
      binaryPath: config.serverUnfairplayPath,
      tempDir: config.unfairplayTempDir,
      maxIpaBytes: UNFAIRPLAY_MAX_IPA_BYTES,
      maxOutputBytes: UNFAIRPLAY_MAX_OUTPUT_BYTES,
      maxModels: UNFAIRPLAY_MAX_MODELS,
      concurrency: 1,
      timeoutMs: UNFAIRPLAY_TIMEOUT_MS,
      maxEntryBytes: 512 * 1024 * 1024,
      maxExpandedBytes: 8 * 1024 * 1024 * 1024,
      minimumFreeBytes: 64 * 1024 * 1024,
    },
  ) {
    try {
      fs.mkdirSync(options.tempDir, { recursive: true, mode: 0o700 });
      if (fs.lstatSync(options.tempDir).isSymbolicLink()) return;
      fs.chmodSync(options.tempDir, 0o700);
      // Only our private request directories are removed, never an arbitrary root.
      for (const entry of fs.readdirSync(options.tempDir)) {
        if (/^request-[a-zA-Z0-9]{6}$/.test(entry)) {
          fs.rmSync(path.join(options.tempDir, entry), { recursive: true, force: true });
        }
      }
      this.initialized = true;
    } catch {
      // Feature availability reports a fixed failure; filesystem paths are private.
    }
  }

  available(): boolean {
    if (!this.options.enabled || !this.initialized) return false;
    try {
      fs.accessSync(this.options.binaryPath, fs.constants.X_OK);
      return fs.statSync(this.options.binaryPath).isFile();
    } catch {
      return false;
    }
  }

  acquire(operation: UnfairplayOperation, signal: AbortSignal): UnfairplayRequest {
    if (!this.available()) throw new UnfairplayError('unfairplay_unavailable', 503);
    if (this.active >= this.options.concurrency) throw new UnfairplayError('unfairplay_busy', 503);
    if (signal.aborted) throw new UnfairplayError('request_canceled', 499);
    this.active++;
    try {
      return new UnfairplayRequest(operation, this.options, signal, () => this.active--);
    } catch (error) {
      this.active--;
      throw failure(error);
    }
  }
}

export class UnfairplayRequest {
  readonly directory: string;
  readonly controller = new AbortController();
  readonly outputPath: string;
  private models: Buffer[] = [];
  private inputPath?: string;
  private stripAccountData = false;
  private cleaned = false;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly abortExternal: () => void;

  constructor(
    readonly operation: UnfairplayOperation,
    private readonly options: Options,
    private readonly externalSignal: AbortSignal,
    private readonly release: () => void,
  ) {
    this.directory = fs.mkdtempSync(path.join(path.resolve(options.tempDir), 'request-'));
    fs.chmodSync(this.directory, 0o700);
    this.outputPath = path.join(this.directory, 'result.ipa');
    this.abortExternal = () => this.controller.abort(new UnfairplayError('request_canceled', 499));
    externalSignal.addEventListener('abort', this.abortExternal, { once: true });
    if (externalSignal.aborted) this.abortExternal();
    this.timer = setTimeout(
      () => this.controller.abort(new UnfairplayError('unfairplay_timeout', 504)),
      options.timeoutMs,
    );
    this.timer.unref();
  }

  private checkSpace(requiredBytes = 0): void {
    const space = fs.statfsSync(this.directory);
    if (space.bavail * space.bsize < this.options.minimumFreeBytes + requiredBytes)
      throw new UnfairplayError('insufficient_space', 507);
  }

  async receive(request: IncomingMessage, resolveSource: SourceResolver): Promise<void> {
    const maximumBody =
      (this.operation === 'model_inspect' ? 0 : this.options.maxIpaBytes) +
      this.options.maxModels * maxModelBytes +
      2 * 1024 * 1024;
    if (Number(request.headers['content-length']) > maximumBody) throw new UnfairplayError('request_too_large', 413);
    let parser: ReturnType<typeof Busboy>;
    try {
      parser = Busboy({
        headers: request.headers,
        limits: {
          files: this.options.maxModels + 1,
          fields: 2,
          parts: this.options.maxModels + 3,
          fileSize: Math.max(this.options.maxIpaBytes, maxModelBytes),
          fieldSize: 1024,
          fieldNameSize: 32,
          headerPairs: 100,
        },
      });
    } catch {
      throw new UnfairplayError('invalid_request', 400);
    }
    let source: UnfairplaySource | undefined;
    let sawIpa = false;
    let sawModels = 0;
    let bodyBytes = 0;
    let settled = false;
    let error: UnfairplayError | undefined;
    const fields = new Set<string>();
    const files = new Set<Readable>();
    const jobs: Promise<void>[] = [];
    await new Promise<void>((resolve, reject) => {
      const finish = async (problem?: UnfairplayError) => {
        if (settled) return;
        settled = true;
        error ??= problem;
        request.unpipe(parser);
        request.removeListener('data', countBody);
        request.removeListener('error', onRequestError);
        this.controller.signal.removeEventListener('abort', onAbort);
        if (error) {
          for (const file of files) file.destroy(error);
          parser.destroy();
          request.resume();
        }
        await Promise.allSettled(jobs);
        if (error) reject(error);
        else resolve();
      };
      const fail = (problem: UnfairplayError) => {
        error ??= problem;
        void finish(error);
      };
      const countBody = (chunk: Buffer) => {
        bodyBytes += chunk.length;
        if (bodyBytes > maximumBody) fail(new UnfairplayError('request_too_large', 413));
      };
      const onRequestError = () => fail(new UnfairplayError('request_canceled', 499));
      const onAbort = () => fail(failure(this.controller.signal.reason, 'request_canceled', 499));
      request.on('data', countBody);
      request.once('error', onRequestError);
      this.controller.signal.addEventListener('abort', onAbort, { once: true });
      parser.on('file', (name, file) => {
        files.add(file);
        file.once('limit', () => fail(new UnfairplayError('request_too_large', 413)));
        if (name === 'ipa' && !sawIpa && this.operation !== 'model_inspect') {
          sawIpa = true;
          this.inputPath = path.join(this.directory, 'input.ipa');
          let nextSpaceCheck = 0;
          let size = 0;
          const bounded = new Transform({
            transform: (chunk: Buffer, _encoding, callback) => {
              size += chunk.length;
              try {
                if (size > this.options.maxIpaBytes) throw new UnfairplayError('request_too_large', 413);
                if (size >= nextSpaceCheck) {
                  this.checkSpace();
                  nextSpaceCheck = size + 16 * 1024 * 1024;
                }
                callback(null, chunk);
              } catch (problem) {
                callback(failure(problem));
              }
            },
          });
          jobs.push(
            pipeline(file, bounded, fs.createWriteStream(this.inputPath, { flags: 'wx', mode: 0o600 }), {
              signal: this.controller.signal,
            }).catch((problem) => fail(failure(problem))),
          );
        } else if (
          name === 'models' &&
          this.operation !== 'strip_account_data' &&
          ++sawModels <= this.options.maxModels
        ) {
          const chunks: Buffer[] = [];
          let size = 0;
          const collect = new Writable({
            write: (chunk: Buffer, _encoding, callback) => {
              size += chunk.length;
              if (size > maxModelBytes) return callback(new UnfairplayError('invalid_model', 400));
              chunks.push(Buffer.from(chunk));
              callback();
            },
          });
          jobs.push(
            pipeline(file, collect, { signal: this.controller.signal })
              .then(() => {
                if (!modelSizes.includes(size)) throw new UnfairplayError('invalid_model', 400);
                this.models.push(Buffer.concat(chunks));
              })
              .catch((problem) => fail(failure(problem)))
              .finally(() => {
                for (const chunk of chunks) chunk.fill(0);
              }),
          );
        } else {
          file.on('error', () => {});
          file.resume();
          fail(new UnfairplayError('invalid_request', 400));
        }
      });
      parser.on('field', (name, value, info) => {
        if (fields.has(name) || info.nameTruncated || info.valueTruncated)
          return fail(new UnfairplayError('invalid_request', 400));
        fields.add(name);
        if (name === 'stripAccountData' && this.operation === 'decrypt' && ['true', 'false'].includes(value)) {
          this.stripAccountData = value === 'true';
        } else if (name === 'source' && this.operation !== 'model_inspect') {
          try {
            source = parseSource(value);
          } catch {
            fail(new UnfairplayError('invalid_request', 400));
          }
        } else fail(new UnfairplayError('invalid_request', 400));
      });
      for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit'])
        parser.on(event, () => fail(new UnfairplayError('request_too_large', 413)));
      parser.once('error', () => fail(new UnfairplayError('invalid_request', 400)));
      parser.once('close', () => {
        void finish();
      });
      if (this.controller.signal.aborted) onAbort();
      else request.pipe(parser);
    });
    if (source) {
      if (sawIpa) throw new UnfairplayError('invalid_request', 400);
      this.inputPath = resolveSource(source);
    }
    if (
      (this.operation !== 'model_inspect' && !this.inputPath) ||
      (modelOperations.has(this.operation) && this.models.length === 0)
    ) {
      throw new UnfairplayError('invalid_request', 400);
    }
    if (this.inputPath) await this.inspectIPA(this.inputPath);
  }

  private async inspectIPA(inputPath: string): Promise<void> {
    try {
      const info = fs.lstatSync(inputPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > this.options.maxIpaBytes) throw new Error();
      const zip = await openZip(inputPath);
      let entries = 0;
      let expanded = 0;
      let nameBytes = 0;
      const names = new Set<string>();
      try {
        for await (const entry of zip) {
          if (this.controller.signal.aborted) throw this.controller.signal.reason;
          const name = entry.filename;
          const normalized = name.replace(/\/$/, '').normalize('NFC').toLowerCase();
          nameBytes += Buffer.byteLength(name);
          expanded += entry.uncompressedSize;
          if (
            ++entries > 100_000 ||
            expanded > this.options.maxExpandedBytes ||
            entry.uncompressedSize > this.options.maxEntryBytes ||
            entry.isEncrypted() ||
            ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000 ||
            !name ||
            name.length > 4096 ||
            nameBytes > 16 * 1024 * 1024 ||
            name.startsWith('/') ||
            /^[a-z]:/i.test(name) ||
            name.includes('\\') ||
            /[\x00-\x1f]/.test(name) ||
            name
              .split('/')
              .some(
                (part, index, parts) => part === '..' || part === '.' || (part === '' && index !== parts.length - 1),
              ) ||
            names.has(normalized)
          )
            throw new Error();
          names.add(normalized);
        }
        if (entries === 0) throw new Error();
      } finally {
        await zip.close();
      }
    } catch (problem) {
      throw failure(problem, 'invalid_input', 400);
    }
  }

  async run(): Promise<{ summary: UnfairplaySummary; outputPath?: string; outputBytes?: number }> {
    this.checkSpace(outputOperations.has(this.operation) && this.inputPath ? fs.statSync(this.inputPath).size : 0);
    const input = JSON.stringify({
      operation: this.operation,
      inputPath: this.inputPath,
      outputPath: outputOperations.has(this.operation) ? this.outputPath : undefined,
      models: this.models.map((model) => model.toString('base64')),
      stripAccountData: this.operation === 'strip_account_data' || this.stripAccountData,
    });
    if (Buffer.byteLength(input) > maxProtocolBytes) throw new UnfairplayError('request_too_large', 413);
    const summary = await new Promise<UnfairplaySummary>((resolve, reject) => {
      const child = spawn(this.options.binaryPath, ['--stdio'], {
        cwd: this.directory,
        env: { LANG: 'C.UTF-8', TZ: 'UTC', TMPDIR: this.directory, GOMEMLIMIT: '256MiB' },
        stdio: ['pipe', 'pipe', 'ignore'],
        shell: false,
      });
      let settled = false;
      let problem: UnfairplayError | undefined;
      let size = 0;
      const chunks: Buffer[] = [];
      const abort = () => {
        problem ??= failure(this.controller.signal.reason, 'request_canceled', 499);
        child.kill('SIGKILL');
      };
      const watch = setInterval(() => {
        try {
          this.checkSpace();
          if (fs.existsSync(this.outputPath) && fs.lstatSync(this.outputPath).size > this.options.maxOutputBytes)
            throw new UnfairplayError('result_too_large', 413);
        } catch (error) {
          problem ??= failure(error);
          child.kill('SIGKILL');
        }
      }, 100);
      watch.unref();
      const finish = (error?: UnfairplayError, value?: UnfairplaySummary) => {
        if (settled) return;
        settled = true;
        clearInterval(watch);
        this.controller.signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(value!);
      };
      this.controller.signal.addEventListener('abort', abort, { once: true });
      if (this.controller.signal.aborted) abort();
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 64 * 1024) {
          problem ??= new UnfairplayError('processing_failed', 502);
          child.kill('SIGKILL');
        } else chunks.push(chunk);
      });
      child.once('error', () => finish(new UnfairplayError('unfairplay_unavailable', 503)));
      child.once('close', (code) => {
        if (problem) return finish(problem);
        if (code !== 0) return finish(new UnfairplayError('processing_failed', 502));
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (result?.ok === false && typeof result.error === 'string' && Object.hasOwn(nativeErrors, result.error))
            return finish(new UnfairplayError(result.error, nativeErrors[result.error]));
          if (result?.ok !== true) throw new Error();
          finish(undefined, safeSummary(result.value));
        } catch {
          finish(new UnfairplayError('processing_failed', 502));
        }
      });
      child.stdin.on('error', () => {
        problem ??= new UnfairplayError('processing_failed', 502);
        child.kill('SIGKILL');
      });
      child.stdin.end(input);
    });
    if (!outputOperations.has(this.operation)) return { summary };
    let info: fs.Stats;
    try {
      info = fs.lstatSync(this.outputPath);
    } catch {
      throw new UnfairplayError('processing_failed', 502);
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size === 0 || info.size > this.options.maxOutputBytes)
      throw new UnfairplayError('processing_failed', 502);
    fs.chmodSync(this.outputPath, 0o600);
    return { summary, outputPath: this.outputPath, outputBytes: info.size };
  }

  async cleanup(): Promise<void> {
    if (this.cleaned) return;
    this.cleaned = true;
    clearTimeout(this.timer);
    this.externalSignal.removeEventListener('abort', this.abortExternal);
    for (const model of this.models) model.fill(0);
    this.models = [];
    try {
      await fs.promises.rm(this.directory, { recursive: true, force: true });
    } finally {
      this.release();
    }
  }
}

export const serverUnfairplay = new UnfairplayService();
