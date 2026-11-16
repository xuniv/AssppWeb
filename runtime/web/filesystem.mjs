// Volatile public-asset workspace for Go's js/wasm Node-compatible filesystem.
// This is never used for account storage. Hosts persist only verified images.
export function createFilesystem(limit = 384 * 1024 * 1024) {
  const constants = {
    O_WRONLY: 1,
    O_RDWR: 2,
    O_CREAT: 64,
    O_EXCL: 128,
    O_TRUNC: 512,
    O_APPEND: 1024,
    O_DIRECTORY: 65536,
  };
  const files = new Map(),
    descriptors = new Map();
  let next = 3,
    allocated = 0;
  let publicErrorCode = '';
  const normalize = (p) => {
    const parts = [];
    for (const bit of p.split('/')) {
      if (bit === '..') parts.pop();
      else if (bit && bit !== '.') parts.push(bit);
    }
    return '/' + parts.join('/');
  };
  const failure = (code) => Object.assign(new Error(code), { code });
  const get = (p) => {
    const f = files.get(normalize(p));
    if (!f) throw failure('ENOENT');
    return f;
  };
  const fd = (n) => {
    const d = descriptors.get(n);
    if (!d) throw failure('EBADF');
    return d;
  };
  const stat = (f) => ({
    dev: 1,
    ino: f.ino,
    mode: f.dir ? 0o40700 : 0o100600,
    nlink: 1,
    uid: 0,
    gid: 0,
    rdev: 0,
    size: f.size,
    blksize: 4096,
    blocks: Math.ceil(f.size / 512),
    atimeMs: 0,
    mtimeMs: 0,
    ctimeMs: 0,
    isDirectory: () => f.dir,
  });
  const perform = (callback, fn) => {
    try {
      callback(null, fn());
    } catch (error) {
      callback(error);
    }
  };
  const resize = (f, size) => {
    if (!Number.isSafeInteger(size) || size < 0 || size > limit) throw failure('EFBIG');
    if (size > f.bytes.length) {
      const capacity = Math.min(limit, Math.max(size, f.bytes.length * 2, 4096));
      if (allocated + capacity - f.bytes.length > limit) throw failure('ENOSPC');
      const data = new Uint8Array(capacity);
      data.set(f.bytes);
      allocated += capacity - f.bytes.length;
      f.bytes = data;
    }
    f.size = size;
  };
  const create = (p, dir = false) => {
    p = normalize(p);
    const f = { bytes: new Uint8Array(), size: 0, dir, ino: files.size + 1 };
    files.set(p, f);
    return f;
  };
  for (const p of ['/', '/tmp', '/cache', '/client']) create(p, true);
  const api = {
    constants,
    writeSync(_n, bytes) {
      return bytes.length;
    }, // Do not expose Go diagnostics or protocol buffers.
    open(p, flags, _mode, cb) {
      const opened = () => {
        p = normalize(p);
        let f = files.get(p);
        if (f && flags & constants.O_CREAT && flags & constants.O_EXCL) throw failure('EEXIST');
        if (!f) {
          if (!(flags & constants.O_CREAT)) throw failure('ENOENT');
          get(p.slice(0, p.lastIndexOf('/')) || '/');
          f = create(p);
        }
        if (flags & constants.O_TRUNC) resize(f, 0);
        const n = next++;
        descriptors.set(n, { file: f, position: flags & constants.O_APPEND ? f.size : 0, stream: null });
        return n;
      };
      perform(cb, opened);
    },
    close(n, cb) {
      perform(cb, () => {
        const d = fd(n);
        void d.stream?.close?.().catch(() => {});
        descriptors.delete(n);
      });
    },
    fstat(n, cb) {
      perform(cb, () => stat(fd(n).file));
    },
    stat(p, cb) {
      perform(cb, () => stat(get(p)));
    },
    lstat(p, cb) {
      api.stat(p, cb);
    },
    fsync(_n, cb) {
      cb(null);
    },
    read(n, buffer, offset, length, position, cb) {
      let d;
      try {
        d = fd(n);
      } catch (error) {
        cb(error);
        return;
      }
      if (d.file.remote) {
        const at = position ?? d.position;
        const count = Math.max(0, Math.min(length, d.file.size - at, 65536));
        if (!length) {
          cb(null, 0);
          return;
        }
        void (async () => {
          d.stream ??= await d.file.remote();
          const bytes = await d.stream.read(at, count || 1);
          if (!(bytes instanceof Uint8Array) || bytes.length > count || (count && !bytes.length)) throw failure('EIO');
          // A JS await may grow Go's WebAssembly memory and detach this view.
          // Go's fs adapter supplies an ordinary staging Uint8Array, not a raw
          // long-lived pointer; copy only the bounded chunk requested here.
          buffer.set(bytes, offset);
          if (position === null) d.position += bytes.length;
          cb(null, bytes.length);
        })().catch((error) => {
          const codes = new Map([
            ['Public image exceeds bounded size', 'public_chunk_limit'],
            ['Public image exceeds pinned size', 'public_image_size'],
            ['Public image read is not sequential', 'public_read_position'],
            ['Client transport failed', 'public_bridge_failed'],
          ]);
          publicErrorCode = codes.get(error?.message) ?? 'public_read_failed';
          cb(error);
        });
        return;
      }
      perform(cb, () => {
        const d = fd(n),
          at = position ?? d.position;
        const count = Math.max(0, Math.min(length, d.file.size - at));
        buffer.set(d.file.bytes.subarray(at, at + count), offset);
        if (position === null) d.position += count;
        return count;
      });
    },
    write(n, buffer, offset, length, position, cb) {
      if (n === 1 || n === 2) {
        cb(null, length);
        return;
      }
      perform(cb, () => {
        const d = fd(n),
          at = position ?? d.position;
        resize(d.file, Math.max(d.file.size, at + length));
        d.file.bytes.set(buffer.subarray(offset, offset + length), at);
        if (position === null) d.position += length;
        return length;
      });
    },
    mkdir(p, _mode, cb) {
      perform(cb, () => {
        p = normalize(p);
        if (files.has(p)) throw failure('EEXIST');
        get(p.slice(0, p.lastIndexOf('/')) || '/');
        create(p, true);
      });
    },
    readdir(p, cb) {
      perform(cb, () => {
        p = normalize(p);
        if (!get(p).dir) throw failure('ENOTDIR');
        const prefix = p === '/' ? '/' : p + '/';
        return [...files.keys()]
          .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/') && key !== p)
          .map((key) => key.slice(prefix.length));
      });
    },
    unlink(p, cb) {
      perform(cb, () => {
        p = normalize(p);
        const f = get(p);
        if (f.dir) throw failure('EISDIR');
        allocated -= f.bytes.length;
        files.delete(p);
      });
    },
    rmdir(p, cb) {
      perform(cb, () => {
        p = normalize(p);
        if ([...files.keys()].some((key) => key.startsWith(p + '/'))) throw failure('ENOTEMPTY');
        get(p);
        files.delete(p);
      });
    },
    rename(a, b, cb) {
      perform(cb, () => {
        a = normalize(a);
        b = normalize(b);
        const f = get(a),
          old = files.get(b);
        if (old) allocated -= old.bytes.length;
        files.set(b, f);
        files.delete(a);
      });
    },
    ftruncate(n, size, cb) {
      perform(cb, () => resize(fd(n).file, size));
    },
    truncate(p, size, cb) {
      perform(cb, () => resize(get(p), size));
    },
    chmod(_p, _mode, cb) {
      cb(null);
    },
    fchmod(_n, _mode, cb) {
      cb(null);
    },
    add(p, data, takeOwnership = false) {
      p = normalize(p);
      const parts = p.split('/');
      for (let i = 2; i < parts.length; i++) {
        const directory = parts.slice(0, i).join('/');
        if (!files.has(directory)) create(directory, true);
      }
      let f = files.get(p);
      if (!f) f = create(p);
      if (takeOwnership) {
        if (allocated - f.bytes.length + data.byteLength > limit) throw failure('ENOSPC');
        allocated += data.byteLength - f.bytes.length;
        f.bytes = data;
        f.size = data.byteLength;
      } else {
        resize(f, data.length);
        f.bytes.set(data);
      }
    },
    addRemote(p, size, open) {
      api.add(p, new Uint8Array(), true);
      const f = get(p);
      f.size = size;
      f.remote = open;
    },
    snapshot() {
      return [...files.entries()]
        .filter(([, f]) => !f.dir)
        .map(([path, f]) => ({ path, bytes: f.bytes.subarray(0, f.size) }));
    },
    clear() {
      for (const [p, f] of files) {
        if (!f.dir) {
          allocated -= f.bytes.length;
          files.delete(p);
        }
      }
    },
    get allocated() {
      return allocated;
    },
    get publicErrorCode() {
      return publicErrorCode;
    },
  };
  for (const method of ['chown', 'fchown', 'lchown', 'link', 'symlink', 'readlink', 'utimes'])
    api[method] = (...args) => args.at(-1)(failure('ENOSYS'));
  return api;
}
