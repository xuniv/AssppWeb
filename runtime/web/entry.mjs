import './wasm_exec.js';
import { createFilesystem } from './filesystem.mjs';
import { initializeUnicorn } from './unicorn.mjs';
import { WispSockets, nativeSockets, fromBase64 } from './sockets.mjs';
import { compressedAsset, nativeAssets } from './assets.mjs';

const revision = 'b352566155a667d8aaeabaa7ecec4966080f92ab';
const cache = '/cache/ipatool/sap/apple-assets-macos-27-26A434-arm64-v5/';
const names = ['AppleMediaServices', 'commerce', 'adid', 'CoreFP', 'CoreFP.icxs', 'fairplayd', 'FairPlayIOKit'];
const sizes = [14813888, 2735088, 3047808, 30764976, 7365344, 17389744, 2132320];
let host,
  initialization,
  prepared = false,
  sequence = 1,
  chain = Promise.resolve();
let goInstance;
let failed;
const pending = new Map();

async function initialize(value) {
  host = value;
  host.progress?.('preparing');
  globalThis.fs = createFilesystem();
  process.cwd = () => '/';
  process.chdir = () => {};
  for (const [index, name] of names.entries())
    fs.addRemote(cache + name, sizes[index], () => host.openAsset(name, sizes[index]));
  globalThis.assppSocket = host.socket;
  host.progress?.('preparing', 'engine');
  await initializeUnicorn();
  const go = new Go();
  goInstance = go;
  go.env = { HOME: '/client', XDG_CACHE_HOME: '/cache', TMPDIR: '/tmp' };
  host.progress?.('preparing', 'wasm');
  const wasm = await host.compile(go.importObject);
  failed = new Promise((_, reject) => {
    const stop = () => {
      prepared = false;
      reject(new Error('Store runtime exited'));
    };
    void go.run(wasm.instance).then(stop, stop);
  });
  void failed.catch(() => {});
  if (typeof globalThis.assppRuntime !== 'function') throw new Error('Store runtime did not start');
}
async function invoke(input) {
  await initialization;
  try {
    if (!prepared) {
      host.progress?.('preparing', 'assets');
      const result = JSON.parse(await execute(JSON.stringify({ operation: 'prepare', deviceID: '020000000001' })));
      if (!result.ok) throw new Error('Apple authentication assets could not be prepared');
      fs.clear();
      prepared = true;
    }
    host.progress?.('running', 'request');
    return await execute(input);
  } finally {
    host.progress?.('');
  }
}
function execute(input) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Store runtime timed out')), 15 * 60 * 1000);
  });
  return Promise.race([assppRuntime(input), failed, timeout]).finally(() => clearTimeout(timer));
}
function run(input) {
  const job = chain.then(() => invoke(input));
  chain = job.catch(() => {});
  return job;
}
function rpc(method, payload, transfer = []) {
  const id = sequence++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    if (globalThis.webkit?.messageHandlers?.storeRuntime)
      webkit.messageHandlers.storeRuntime.postMessage({ id, method, payload });
    else postMessage({ type: 'host', id, method, payload }, transfer);
  });
}
function reply(message) {
  const job = pending.get(message.id);
  if (!job) return;
  pending.delete(message.id);
  if (message.error) job.reject(new Error('Client transport failed'));
  else job.resolve(message.value);
}
const statistics = () => ({
  goBytes: goInstance?._inst?.exports.mem.buffer.byteLength ?? 0,
  emulatorBytes: globalThis.assppUnicorn?.memoryBytes() ?? 0,
  workspaceBytes: globalThis.fs?.allocated ?? 0,
  sharedMemory: globalThis.assppUnicorn?.memoryStatistics(),
});
globalThis.asspp = { run, revision, statistics };
if (globalThis.webkit?.messageHandlers?.storeRuntime) {
  globalThis.assppHostReply = reply;
  initialization = initialize({
    socket: nativeSockets(rpc),
    compile: async (imports) => {
      const { size } = await rpc('binarySize', {});
      if (!Number.isSafeInteger(size) || size <= 0 || size > 40 * 1024 * 1024) throw new Error('Invalid runtime size');
      const bytes = new Uint8Array(size);
      for (let offset = 0; offset < size; offset += 65536) {
        const chunk = fromBase64(await rpc('binaryRead', { offset, count: Math.min(65536, size - offset) }));
        if (chunk.length !== Math.min(65536, size - offset)) throw new Error('Incomplete runtime chunk');
        bytes.set(chunk, offset);
      }
      return await WebAssembly.instantiate(bytes, imports);
    },
    openAsset: nativeAssets(rpc),
    // Native readAsset already checks and caches the packaged public images.
    // Sending them back through JSON would duplicate all 78 MiB unnecessarily.
    progress: (stage, phase) => void rpc('progress', { stage, phase: phase ?? '' }),
  });
  initialization.then(
    () => rpc('ready', {}),
    () => rpc('initializationFailed', {}),
  );
} else {
  globalThis.onmessage = async ({ data }) => {
    if (data.type === 'reply') {
      reply(data);
      return;
    }
    if (data.type === 'initialize') {
      initialization = initialize({
        socket: new WispSockets(data.wispURL),
        compile: (imports) => WebAssembly.instantiateStreaming(fetch(new URL('runtime.wasm', location.href)), imports),
        openAsset: compressedAsset,
        progress: (stage) => postMessage({ type: 'progress', stage }),
      });
      initialization.then(
        () => postMessage({ type: 'ready' }),
        () => postMessage({ type: 'fatal', error: 'Store runtime initialization failed' }),
      );
      return;
    }
    if (data.type === 'run') {
      try {
        postMessage({ type: 'result', id: data.id, value: await run(data.input) });
      } catch {
        postMessage({ type: 'result', id: data.id, error: 'Store runtime failed to prepare or execute' });
      }
    }
    if (data.type === 'statistics') postMessage({ type: 'statistics', value: statistics() });
  };
}
