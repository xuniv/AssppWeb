export type UnfairPlayOperation =
  | 'model_inspect'
  | 'doctor'
  | 'verify'
  | 'decrypt'
  | 'strip_account_data'
  | 'convert_ipa_macos';
export interface UnfairPlayProgress {
  stage: 'initializing' | 'reading' | 'decrypting' | 'writing';
  completedBytes?: number;
  totalBytes?: number;
}
export interface UnfairPlayOptions {
  operation: UnfairPlayOperation;
  input?: Blob | { url: string; headers: Record<string, string> };
  models: Blob[];
  stripAccountData?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: UnfairPlayProgress) => void;
}
export interface UnfairPlayResult {
  ipa?: Blob;
  report: Blob;
  summary: Record<string, unknown>;
  dispose: () => Promise<void>;
}

// A new worker owns each operation. Private files never enter fetch or a server
// request. Terminating it cancels Go and closes its private OPFS file handles.
export async function runUnfairPlay(options: UnfairPlayOptions): Promise<UnfairPlayResult> {
  if (options.signal?.aborted) throw new DOMException('Canceled', 'AbortError');
  const directory = `asspp-unfairplay-${crypto.randomUUID()}`;
  const worker = new Worker('/unfairplay/unfairplay-worker.js');
  let retained = false;
  const dispose = async () => {
    if (!navigator.storage?.getDirectory) return;
    let root: FileSystemDirectoryHandle;
    try {
      root = await navigator.storage.getDirectory();
    } catch {
      return;
    }
    for (const delay of [0, 50, 100, 250, 500, 1000]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        await root.removeEntry(directory, { recursive: true });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'NotFoundError') return;
      }
    }
    throw new Error('unfairplay_cleanup_failed');
  };
  try {
    return await new Promise<UnfairPlayResult>((resolve, reject) => {
      const abort = () => {
        worker.terminate();
        reject(new DOMException('Canceled', 'AbortError'));
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      const finish = () => options.signal?.removeEventListener('abort', abort);
      worker.onerror = () => {
        finish();
        reject(new Error('unfairplay_worker_failed'));
      };
      worker.onmessage = ({ data }) => {
        if (data.type === 'ready') {
          // Feature/quota checks complete before any IPA or private model is
          // sent even to this local worker. Blob cloning does not copy an IPA.
          worker.postMessage({
            type: 'run',
            operation: options.operation,
            input: options.input,
            models: options.models,
            stripAccountData: options.stripAccountData === true,
          });
        } else if (data.type === 'progress') {
          options.onProgress?.(data.value);
        } else if (data.type === 'result') {
          finish();
          retained = data.ipa instanceof Blob;
          resolve({ ipa: data.ipa, report: data.report, summary: data.summary, dispose });
        } else if (data.type === 'error') {
          finish();
          const allowed = [
            'unfairplay_browser_unsupported',
            'unfairplay_storage_unavailable',
            'unfairplay_storage_full',
            'unfairplay_invalid_input',
            'unfairplay_operation_failed',
            'unfairplay_worker_failed',
          ];
          reject(new Error(allowed.includes(data.code) ? data.code : 'unfairplay_operation_failed'));
        }
      };
      options.onProgress?.({ stage: 'initializing' });
      worker.postMessage({ type: 'initialize', directory, operation: options.operation });
    });
  } finally {
    worker.terminate();
    if (!retained) await dispose();
  }
}
export const decryptUnfairPlay = (options: Omit<UnfairPlayOptions, 'operation'>) =>
  runUnfairPlay({ ...options, operation: 'decrypt' });
export async function validateUnfairPlayModel(model: Blob): Promise<{ version: number; bytes: number }> {
  const result = await runUnfairPlay({ operation: 'model_inspect', models: [model] });
  const value = result.summary.models as { version: number; bytes: number }[];
  return value[0];
}
