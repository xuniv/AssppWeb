// Public images are consumed sequentially by Go's hash-verifying loader. Keep
// only the current decompressor chunk in JS; never duplicate all 78 MiB there.
export async function compressedAsset(name, expected) {
  const response = await fetch(new URL(`assets/${name}.zlib`, location.href));
  if (!response.ok || !response.body) throw new Error('Public Apple asset unavailable');
  const reader = response.body.pipeThrough(new DecompressionStream('deflate')).getReader();
  let pending = new Uint8Array(),
    offset = 0,
    finished = false;
  return {
    async read(at, max) {
      if (at !== offset) throw new Error('Public image read is not sequential');
      if (!pending.length && !finished) {
        const result = await reader.read();
        finished = result.done;
        pending = result.value ?? new Uint8Array();
        if (pending.length > 1024 * 1024 || pending.length > expected - offset)
          throw new Error('Public image exceeds bounded size');
      }
      if (at === expected && pending.length) throw new Error('Public image exceeds pinned size');
      const count = Math.min(max, pending.length),
        result = pending.subarray(0, count);
      pending = pending.subarray(count);
      offset += count;
      return result;
    },
    async close() {
      pending = new Uint8Array();
      await reader.cancel();
    },
  };
}

export function nativeAssets(rpc) {
  return async (name) => {
    const opened = await rpc('assetOpen', { name });
    if (!Number.isSafeInteger(opened.id)) throw new Error('Public image could not be opened');
    return {
      async read(offset, count) {
        const text = await rpc('assetRead', { id: opened.id, offset, count: Math.min(count, 65536) });
        // Fixed-size chunks keep Foundation/IPC/base64 copies bounded too.
        const binary = atob(text),
          bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
      },
      close: () => rpc('assetClose', { id: opened.id }),
    };
  };
}
