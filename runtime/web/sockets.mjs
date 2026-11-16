const allowed = (host) =>
  /^(?:[a-z0-9-]+\.)*itunes\.apple\.com$/.test(host) ||
  /^(?:[a-z0-9-]+\.)*mzstatic\.com$/.test(host) ||
  [
    'gsa.apple.com',
    'www.apple.com',
    'updates.cdn-apple.com',
    'mesu.apple.com',
    'wkms-public.apple.com',
    'fcs-keys-pub-prod.cdn-apple.com',
  ].includes(host);
const error = () => new Error('Apple TCP connection failed');

// Wisp v1 only forwards TCP. TLS, host validation and trust roots live in Go.
export class WispSockets {
  constructor(url) {
    this.streams = new Map();
    this.next = 1;
    this.connected = false;
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(error());
        this.ws.close();
      }, 15000);
      this.ws.addEventListener('message', (event) => {
        try {
          const bytes = new Uint8Array(event.data);
          if (bytes.length < 5) throw error();
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
            kind = bytes[0],
            id = view.getUint32(1, true);
          if (kind === 3 && id === 0 && bytes.length >= 9) {
            this.capacity = view.getUint32(5, true);
            this.connected = true;
            clearTimeout(timer);
            resolve();
            return;
          }
          const s = this.streams.get(id);
          if (!s) return;
          if (kind === 2) {
            const data = bytes.slice(5);
            s.buffered += data.length;
            if (s.buffered > 8 * 1024 * 1024) throw error();
            s.queue.push(data);
            this.fulfill(s);
          } else if (kind === 3 && bytes.length >= 9) {
            s.slots = view.getUint32(5, true);
            this.flush(s);
          } else if (kind === 4) {
            s.closed = true;
            this.fulfill(s);
            for (const item of s.writes.splice(0)) item.reject(error());
          }
        } catch {
          this.ws.close();
        }
      });
      const close = () => {
        clearTimeout(timer);
        reject(error());
        for (const s of this.streams.values()) {
          s.closed = true;
          this.fulfill(s);
          for (const item of s.writes.splice(0)) item.reject(error());
        }
      };
      this.ws.addEventListener('close', close);
      this.ws.addEventListener('error', close);
    });
  }
  packet(kind, id, payload) {
    const data = new Uint8Array(5 + payload.length);
    data[0] = kind;
    new DataView(data.buffer).setUint32(1, id, true);
    data.set(payload, 5);
    this.ws.send(data);
  }
  async open(host, port) {
    if (!allowed(host) || port !== 443) throw error();
    await this.ready;
    if (this.streams.size >= 32) throw error();
    const id = this.next++;
    const s = { id, queue: [], buffered: 0, slots: this.capacity, closed: false, writes: [], read: null };
    this.streams.set(id, s);
    const name = new TextEncoder().encode(host),
      payload = new Uint8Array(name.length + 3);
    payload[0] = 1;
    new DataView(payload.buffer).setUint16(1, port, true);
    payload.set(name, 3);
    this.packet(1, id, payload);
    return id;
  }
  fulfill(s) {
    if (!s.read || (!s.queue.length && !s.closed)) return;
    const { max, resolve, timer } = s.read;
    s.read = null;
    clearTimeout(timer);
    const data = s.queue[0] ?? new Uint8Array(),
      part = data.subarray(0, max);
    s.buffered -= part.length;
    if (part.length === data.length) s.queue.shift();
    else s.queue[0] = data.subarray(max);
    resolve(part);
  }
  read(id, max) {
    const s = this.streams.get(id);
    if (!s || s.read || max < 1 || max > 65536) return Promise.reject(error());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        s.read = null;
        reject(error());
        void this.close(id);
      }, 30000);
      s.read = { max, resolve, reject, timer };
      this.fulfill(s);
    });
  }
  flush(s) {
    while (s.slots > 0 && s.writes.length && !s.closed) {
      const item = s.writes.shift();
      this.packet(2, s.id, item.data);
      s.slots--;
      item.resolve(item.data.length);
    }
  }
  write(id, data) {
    const s = this.streams.get(id);
    if (!s || s.closed || data.length > 1024 * 1024) return Promise.reject(error());
    return new Promise((resolve, reject) => {
      s.writes.push({ data, resolve, reject });
      this.flush(s);
    });
  }
  async close(id) {
    const s = this.streams.get(id);
    if (!s) return;
    if (!s.closed && this.ws.readyState === WebSocket.OPEN) this.packet(4, id, new Uint8Array([1]));
    s.closed = true;
    this.fulfill(s);
    for (const item of s.writes.splice(0)) item.reject(error());
    this.streams.delete(id);
  }
}

export function nativeSockets(rpc) {
  return {
    open: (host, port) => rpc('socketOpen', { host, port }),
    read: async (id, max) => fromBase64(await rpc('socketRead', { id, max })),
    write: (id, data) => rpc('socketWrite', { id, data: toBase64(data) }),
    close: (id) => rpc('socketClose', { id }),
  };
}
export function toBase64(bytes) {
  let text = '';
  for (let at = 0; at < bytes.length; at += 32768) text += String.fromCharCode(...bytes.subarray(at, at + 32768));
  return btoa(text);
}
export function fromBase64(text) {
  const value = atob(text);
  return Uint8Array.from(value, (c) => c.charCodeAt(0));
}
