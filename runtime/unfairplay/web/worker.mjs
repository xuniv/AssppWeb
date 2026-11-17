import '../../web/wasm_exec.js';

const maximumBytes = 8 * 1024 ** 3;
const chunkBytes = 65536;
let storageFull = false;
let directory,
  directoryName,
  input,
  output,
  outputFile,
  go,
  initialized = false,
  running = false;
let modelBytes = [],
  nextScratch = 1,
  initializedOperation;
const scratch = new Map();
const reader = typeof FileReaderSync === 'function' ? new FileReaderSync() : null;
const readBuffer = new Uint8Array(chunkBytes);
const progress = (stage, completedBytes, totalBytes) =>
  postMessage({ type: 'progress', value: { stage, completedBytes, totalBytes } });
const failure = (code) => postMessage({ type: 'error', code });
const storageCall = (action) => {
  try {
    return action();
  } catch (error) {
    if (error?.name === 'QuotaExceededError') storageFull = true;
    throw error;
  }
};
const close = () => {
  try {
    output?.flush();
    output?.close();
  } catch {}
  output = undefined;
  for (const file of scratch.values()) {
    try {
      file.close();
    } catch {}
  }
  scratch.clear();
  for (const bytes of modelBytes) bytes.fill(0);
  modelBytes = [];
};
async function initialize(name, operation) {
  const inspectOnly = operation === 'model_inspect';
  initializedOperation = operation;
  if (
    typeof WebAssembly !== 'object' ||
    (!inspectOnly && (!reader || !navigator.storage?.getDirectory)) ||
    !/^asspp-unfairplay-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name)
  ) {
    throw new Error('unfairplay_browser_unsupported');
  }
  directoryName = name;
  if (!inspectOnly)
    try {
      const root = await navigator.storage.getDirectory();
      directory = await root.getDirectoryHandle(name, { create: true });
      const probe = await directory.getFileHandle('probe', { create: true });
      if (!probe.createSyncAccessHandle) throw new Error('unsupported');
      const handle = await probe.createSyncAccessHandle();
      handle.close();
      await directory.removeEntry('probe');
    } catch {
      throw new Error('unfairplay_storage_unavailable');
    }
  globalThis.assppUnfairHost = {
    readInput(at, count) {
      if (!Number.isSafeInteger(at) || at < 0 || count > chunkBytes || count < 0) throw new Error('invalid read');
      return new Uint8Array(reader.readAsArrayBuffer(input.slice(at, at + count)));
    },
    readModel(index) {
      return modelBytes[index];
    },
    async openScratch(size) {
      if (!Number.isSafeInteger(size) || size < 0 || size > maximumBytes) throw new Error('invalid size');
      const id = nextScratch++;
      const file = await directory.getFileHandle(`scratch-${id}`, { create: true });
      const handle = await file.createSyncAccessHandle();
      scratch.set(id, handle);
      return id;
    },
    readScratch(id, at, count) {
      if (count > chunkBytes || count < 0) throw new Error('invalid read');
      const n = scratch.get(id).read(readBuffer.subarray(0, count), { at });
      return readBuffer.subarray(0, n);
    },
    writeScratch(id, at, bytes) {
      return storageCall(() => scratch.get(id).write(bytes, { at }));
    },
    truncateScratch(id, size) {
      scratch.get(id).truncate(size);
    },
    closeScratch(id) {
      scratch.get(id)?.close();
      scratch.delete(id);
    },
    writeOutput(at, bytes) {
      if (at + bytes.length > maximumBytes) throw new Error('output limit');
      return storageCall(() => output.write(bytes, { at }));
    },
  };
  go = new Go();
  go.env = { TMPDIR: '/', HOME: '/' };
  const response = await fetch(new URL('unfairplay.wasm', location.href));
  if (!response.ok) throw new Error('unfairplay_worker_failed');
  const wasm = await WebAssembly.instantiateStreaming(response, go.importObject);
  void go.run(wasm.instance).catch(() => failure('unfairplay_worker_failed'));
  if (typeof assppUnfairRun !== 'function') throw new Error('unfairplay_worker_failed');
  initialized = true;
  postMessage({ type: 'ready' });
}
async function loadInput(value) {
  if (value instanceof Blob) return value;
  if (!value || typeof value.url !== 'string') throw new Error('unfairplay_invalid_input');
  const url = new URL(value.url, location.origin);
  if (url.origin !== location.origin || !url.pathname.startsWith('/api/') || url.username || url.password || url.hash) {
    throw new Error('unfairplay_invalid_input');
  }
  // Only access authentication is accepted; no arbitrary cookies, destinations
  // or Apple credential headers are forwarded through this source reader.
  const headers = {};
  for (const [key, text] of Object.entries(value.headers ?? {})) {
    if (key.toLowerCase() !== 'x-access-token' || typeof text !== 'string') throw new Error('unfairplay_invalid_input');
    headers[key] = text;
  }
  const response = await fetch(url, { headers, cache: 'no-store', redirect: 'error' });
  if (!response.ok || !response.body) throw new Error('unfairplay_operation_failed');
  const size = Number(response.headers.get('content-length')) || undefined;
  if (size > maximumBytes) throw new Error('unfairplay_invalid_input');
  const file = await directory.getFileHandle('input.ipa', { create: true });
  const handle = await file.createSyncAccessHandle();
  let at = 0;
  try {
    const stream = response.body.getReader();
    for (;;) {
      const item = await stream.read();
      if (item.done) break;
      for (let offset = 0; offset < item.value.length; offset += chunkBytes) {
        const chunk = item.value.subarray(offset, offset + chunkBytes);
        if (at + chunk.length > maximumBytes) {
          await stream.cancel();
          throw new Error('unfairplay_invalid_input');
        }
        if (handle.write(chunk, { at }) !== chunk.length) throw new Error('unfairplay_storage_full');
        at += chunk.length;
      }
      progress('reading', at, size);
    }
    if (size !== undefined && at !== size) throw new Error('unfairplay_operation_failed');
    handle.flush();
  } finally {
    handle.close();
  }
  return file.getFile();
}
async function run(data) {
  if (!initialized || running) throw new Error('unfairplay_invalid_input');
  running = true;
  const operations = ['model_inspect', 'doctor', 'verify', 'decrypt', 'strip_account_data', 'convert_ipa_macos'];
  if (
    data.operation !== initializedOperation ||
    !operations.includes(data.operation) ||
    !Array.isArray(data.models) ||
    data.models.length > 256
  ) {
    throw new Error('unfairplay_invalid_input');
  }
  for (const model of data.models) {
    if (!(model instanceof Blob) || ![4176, 4184, 8708].includes(model.size))
      throw new Error('unfairplay_invalid_input');
    modelBytes.push(new Uint8Array(await model.arrayBuffer()));
  }
  if (data.operation !== 'model_inspect') {
    input = await loadInput(data.input);
    if (input.size <= 0 || input.size > maximumBytes) throw new Error('unfairplay_invalid_input');
  }
  const writesIpa = ['decrypt', 'strip_account_data', 'convert_ipa_macos'].includes(data.operation);
  if (writesIpa) {
    outputFile = await directory.getFileHandle('output.ipa', { create: true });
    output = await outputFile.createSyncAccessHandle();
  }
  progress('decrypting', 0, input?.size);
  const summary = JSON.parse(
    await assppUnfairRun(
      JSON.stringify({
        operation: data.operation,
        size: input?.size ?? 0,
        models: modelBytes.length,
        stripAccountData: data.stripAccountData === true,
      }),
    ),
  );
  close();
  const report = new Blob([summary.report ?? JSON.stringify(summary)], { type: 'application/json' });
  delete summary.report;
  const ipa = writesIpa ? await outputFile.getFile() : undefined;
  // Keep only the returned output backing; the caller owns explicit disposal.
  if (directory)
    for await (const [name] of directory.entries()) if (name !== 'output.ipa') await directory.removeEntry(name);
  progress('writing', ipa?.size, ipa?.size);
  postMessage({
    type: 'result',
    ipa,
    report,
    summary: { ...summary, goBytes: go._inst.exports.mem.buffer.byteLength },
  });
}
onmessage = ({ data }) => {
  const promise =
    data.type === 'initialize'
      ? initialize(data.directory, data.operation)
      : data.type === 'run'
        ? run(data)
        : Promise.reject();
  void promise.catch((error) => {
    close();
    const code = storageFull || error?.name === 'QuotaExceededError' ? 'unfairplay_storage_full' : error?.message;
    const allowed = [
      'unfairplay_browser_unsupported',
      'unfairplay_storage_unavailable',
      'unfairplay_storage_full',
      'unfairplay_invalid_input',
      'unfairplay_worker_failed',
    ];
    failure(allowed.includes(code) ? code : 'unfairplay_operation_failed');
  });
};
