// TEST ONLY: WPE's automation embedder disables StorageManager. This bounded
// memory shim exercises WebKit Go/WASM correctness and CPU, not OPFS support or
// production memory. Never import this file in the published worker.
const pageSize = 65536;
class MemoryFile {
  constructor() {
    this.pages = new Map();
    this.size = 0;
  }
  async createSyncAccessHandle() {
    const file = this;
    return {
      write(bytes, { at }) {
        if (at + bytes.length > 256 * 1024 ** 2) throw new Error('Synthetic control size limit');
        for (let copied = 0; copied < bytes.length; ) {
          const position = at + copied,
            index = Math.floor(position / pageSize),
            offset = position % pageSize;
          if (!file.pages.has(index)) file.pages.set(index, new Uint8Array(pageSize));
          const count = Math.min(bytes.length - copied, pageSize - offset);
          file.pages.get(index).set(bytes.subarray(copied, copied + count), offset);
          copied += count;
        }
        file.size = Math.max(file.size, at + bytes.length);
        return bytes.length;
      },
      read(bytes, { at }) {
        const size = Math.max(0, Math.min(bytes.length, file.size - at));
        for (let copied = 0; copied < size; ) {
          const position = at + copied,
            index = Math.floor(position / pageSize),
            offset = position % pageSize;
          const count = Math.min(size - copied, pageSize - offset),
            page = file.pages.get(index);
          if (page) bytes.set(page.subarray(offset, offset + count), copied);
          else bytes.fill(0, copied, copied + count);
          copied += count;
        }
        return size;
      },
      truncate(size) {
        file.size = size;
      },
      flush() {},
      close() {},
    };
  }
  async getFile() {
    const parts = [];
    for (let at = 0; at < this.size; at += pageSize)
      parts.push(
        (this.pages.get(at / pageSize) ?? new Uint8Array(pageSize)).subarray(0, Math.min(pageSize, this.size - at)),
      );
    return new Blob(parts);
  }
}
class MemoryDirectory {
  constructor() {
    this.items = new Map();
  }
  async getDirectoryHandle(name) {
    if (!this.items.has(name)) this.items.set(name, new MemoryDirectory());
    return this.items.get(name);
  }
  async getFileHandle(name) {
    if (!this.items.has(name)) this.items.set(name, new MemoryFile());
    return this.items.get(name);
  }
  async removeEntry(name) {
    this.items.delete(name);
  }
  async *entries() {
    yield* this.items.entries();
  }
}
const root = new MemoryDirectory();
Object.defineProperty(navigator, 'storage', { value: { getDirectory: async () => root } });
importScripts('/unfairplay/unfairplay-worker.js');
