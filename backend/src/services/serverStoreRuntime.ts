import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  config,
  SERVER_RUNTIME_CONCURRENCY,
  SERVER_RUNTIME_MAX_BYTES,
  SERVER_RUNTIME_MAX_OUTPUT_BYTES,
  SERVER_RUNTIME_TIMEOUT_MS,
} from '../config.js';

interface RuntimeOptions {
  enabled: boolean;
  binaryPath: string;
  assetsPath: string;
  concurrency: number;
  timeoutMs: number;
  maxOutputBytes: number;
}

export class ServerRuntimeError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
  }
}

const safeRuntimeErrors = new Set([
  'invalid_request',
  'invalid_device_id',
  'invalid_state',
  'invalid_platform',
  'runtime_failed',
  'runtime_not_configured',
  'tls_untrusted_certificate',
  'tls_hostname_mismatch',
  'tls_certificate_failed',
  'request_timeout',
  'connection_closed',
  'connection_failed',
  'operation_failed',
  'verification_required',
  'token_expired',
  'license_required',
  'license_exists',
]);

// Each child owns exactly one operation. Accounts, cookies and provisioning
// records travel only through private pipes and are never saved or logged here.
export class ServerStoreRuntime {
  private active = 0;

  constructor(
    private readonly options: RuntimeOptions = {
      enabled: config.serverStoreRuntimeEnabled,
      binaryPath: config.serverStoreRuntimePath,
      assetsPath: config.serverStoreRuntimeAssets,
      concurrency: SERVER_RUNTIME_CONCURRENCY,
      timeoutMs: SERVER_RUNTIME_TIMEOUT_MS,
      maxOutputBytes: SERVER_RUNTIME_MAX_OUTPUT_BYTES,
    },
  ) {}

  available(): boolean {
    if (!this.options.enabled) return false;
    try {
      fs.accessSync(this.options.binaryPath, fs.constants.X_OK);
      return fs.statSync(this.options.binaryPath).isFile() && fs.statSync(this.options.assetsPath).isDirectory();
    } catch {
      return false;
    }
  }

  run(input: string, signal: AbortSignal): Promise<Buffer> {
    if (!this.available()) return Promise.reject(new ServerRuntimeError('server_runtime_unavailable', 503));
    if (Buffer.byteLength(input) > SERVER_RUNTIME_MAX_BYTES) {
      return Promise.reject(new ServerRuntimeError('request_too_large', 413));
    }
    if (this.active >= this.options.concurrency) {
      return Promise.reject(new ServerRuntimeError('server_runtime_busy', 503));
    }
    if (signal.aborted) return Promise.reject(new ServerRuntimeError('request_canceled', 499));
    this.active++;
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.binaryPath, ['--stdio', path.resolve(this.options.assetsPath)], {
        cwd: path.dirname(path.resolve(this.options.binaryPath)),
        // Do not expose operator secrets, proxy credentials, or custom CA roots.
        env: { LANG: 'C.UTF-8', TZ: 'UTC' },
        stdio: ['pipe', 'pipe', 'ignore'],
        shell: false,
      });
      let settled = false;
      let failure: ServerRuntimeError | undefined;
      let size = 0;
      const chunks: Buffer[] = [];
      const abort = () => {
        failure ??= new ServerRuntimeError('request_canceled', 499);
        child.kill('SIGKILL');
      };
      const timer = setTimeout(() => {
        failure ??= new ServerRuntimeError('server_runtime_timeout', 504);
        child.kill('SIGKILL');
      }, this.options.timeoutMs);
      const finish = (error?: ServerRuntimeError, output?: Buffer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        this.active--;
        if (error) reject(error);
        else resolve(output!);
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > this.options.maxOutputBytes) {
          failure ??= new ServerRuntimeError('server_runtime_failed', 502);
          child.kill('SIGKILL');
          return;
        }
        chunks.push(chunk);
      });
      child.on('error', () => finish(new ServerRuntimeError('server_runtime_unavailable', 503)));
      child.on('close', (code) => {
        if (failure) return finish(failure);
        if (code !== 0) return finish(new ServerRuntimeError('server_runtime_failed', 502));
        const output = Buffer.concat(chunks);
        try {
          const value = JSON.parse(output.toString('utf8'));
          if (
            !value ||
            typeof value.ok !== 'boolean' ||
            !value.state ||
            typeof value.state !== 'object' ||
            (value.error !== undefined && !safeRuntimeErrors.has(value.error)) ||
            (value.status !== undefined && (!Number.isInteger(value.status) || value.status < 0 || value.status > 599))
          ) {
            return finish(new ServerRuntimeError('server_runtime_failed', 502));
          }
        } catch {
          return finish(new ServerRuntimeError('server_runtime_failed', 502));
        }
        finish(undefined, output);
      });
      child.stdin.on('error', () => {
        failure ??= new ServerRuntimeError('server_runtime_failed', 502);
        child.kill('SIGKILL');
      });
      child.stdin.end(input);
    });
  }
}

export const serverStoreRuntime = new ServerStoreRuntime();
