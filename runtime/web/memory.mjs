// Native-like anonymous RAM with shared immutable pages and copy-on-write.
// All backing pointers refer to Unicorn's own WASM memory, never host memory.
export function sharedMemory(uc) {
  const cache = new Map();
  let backingBytes = 0,
    peakBackingBytes = 0,
    sharingHits = 0,
    sharedBytes = 0;
  const allocate = (size) => {
    const allocation = uc._malloc(size + 4095);
    if (!allocation) throw new Error('Guest RAM allocation failed');
    backingBytes += size;
    peakBackingBytes = Math.max(peakBackingBytes, backingBytes);
    return { allocation, pointer: Math.ceil(allocation / 4096) * 4096, size, references: 1, key: null };
  };
  const zero = allocate(65536);
  const readBuffer = new Uint8Array(65536);
  uc.heapBytes().fill(0, zero.pointer, zero.pointer + zero.size);
  const release = (backing) => {
    if (!backing || backing === zero || --backing.references) return;
    if (backing.key !== null) {
      const candidates = cache.get(backing.key);
      candidates.delete(backing);
      if (!candidates.size) cache.delete(backing.key);
    }
    uc._free(backing.allocation);
    backingBytes -= backing.size;
  };
  const check = (code) => {
    if (code !== 0) throw new Error('Guest memory mapping failed');
  };
  const hash = (pointer, size) => {
    const heap = new Uint32Array(uc.heapBytes().buffer, pointer, size / 4);
    let value = 2166136261;
    for (let i = 0; i < heap.length; i++) value = Math.imul(value ^ heap[i], 16777619);
    return size + ':' + (value >>> 0);
  };
  const identical = (a, b, size) => {
    const left = new Uint32Array(uc.heapBytes().buffer, a, size / 4),
      right = new Uint32Array(uc.heapBytes().buffer, b, size / 4);
    for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
    return true;
  };
  return {
    statistics: () => ({ backingBytes, peakBackingBytes, sharingHits, sharedBytes }),
    create(engine) {
      const handle = uc.getValue(engine.handle_ptr, '*');
      const blocks = new Set(),
        buckets = new Map();
      let sealed = false,
        active = false;
      const put = (block) => {
        blocks.add(block);
        const key = block.begin >> 16n;
        if (!buckets.has(key)) buckets.set(key, new Set());
        buckets.get(key).add(block);
      };
      const erase = (block) => {
        blocks.delete(block);
        const key = block.begin >> 16n,
          bucket = buckets.get(key);
        bucket.delete(block);
        if (!bucket.size) buckets.delete(key);
      };
      const find = (address) =>
        [...(buckets.get(address >> 16n) ?? [])].find((b) => address >= b.begin && address < b.end);
      const attach = (block, backing, readonly) => {
        if (active)
          check(uc._uc_mem_map_ptr(handle, block.begin, BigInt(block.size), readonly ? 5 : 7, backing.pointer));
        block.backing = backing;
        block.readonly = readonly;
      };
      const replace = (block, backing, readonly) => {
        if (active) check(uc._uc_mem_unmap(handle, block.begin, BigInt(block.size)));
        const previous = block.backing;
        attach(block, backing, readonly);
        release(previous);
      };
      const ensure = (address, size, writable = false) => {
        const end = address + BigInt(size);
        for (let at = address; at < end; ) {
          const block = find(at);
          if (!block) return false;
          if (!block.backing) {
            if (writable) {
              const backing = allocate(block.size);
              uc.heapBytes().fill(0, backing.pointer, backing.pointer + block.size);
              attach(block, backing, false);
            } else attach(block, zero, true);
          }
          if (writable && block.readonly) {
            const next = allocate(block.size);
            uc.heapBytes().copyWithin(next.pointer, block.backing.pointer, block.backing.pointer + block.size);
            replace(block, next, false);
          }
          at = block.end;
        }
        return true;
      };
      const api = {
        covers(address, size) {
          const end = address + BigInt(size);
          for (let at = address; at < end; ) {
            const block = find(at);
            if (!block) return false;
            at = block.end;
          }
          return true;
        },
        map(begin, size) {
          const end = begin + BigInt(size);
          if (begin % 4096n || end % 4096n || size <= 0) throw new Error('Invalid guest region');
          // Use large blocks inside a region, retaining 4 KiB boundary accuracy.
          const added = [];
          for (let at = begin; at < end; ) {
            const next = ((at >> 16n) + 1n) << 16n,
              last = next < end ? next : end;
            if ([...(buckets.get(at >> 16n) ?? [])].some((b) => at < b.end && last > b.begin))
              throw new Error('Guest region already mapped');
            added.push({ begin: at, end: last, size: Number(last - at), backing: null, readonly: true });
            at = last;
          }
          added.forEach(put);
        },
        unmap(begin, size) {
          const end = begin + BigInt(size);
          if (begin % 4096n || end % 4096n) throw new Error('Invalid guest unmapping');
          for (const block of [...blocks]) {
            if (block.end <= begin || block.begin >= end) continue;
            const remaining = [];
            if (block.begin < begin) remaining.push([block.begin, begin]);
            if (block.end > end) remaining.push([end, block.end]);
            // Partial unmaps retain the surviving bytes, with independent RAM.
            for (const [first, last] of remaining) {
              const part = { begin: first, end: last, size: Number(last - first), backing: null, readonly: false };
              if (block.backing) {
                const backing = allocate(part.size),
                  offset = Number(first - block.begin);
                uc.heapBytes().copyWithin(
                  backing.pointer,
                  block.backing.pointer + offset,
                  block.backing.pointer + offset + part.size,
                );
                part.backing = backing;
              }
              put(part);
            }
            if (active && block.backing) check(uc._uc_mem_unmap(handle, block.begin, BigInt(block.size)));
            erase(block);
            for (const part of [...blocks]) {
              if (part.backing && remaining.some(([a, b]) => part.begin === a && part.end === b)) {
                const backing = part.backing;
                attach(part, backing, false);
              }
            }
            release(block.backing);
          }
        },
        fault(kind, address, size) {
          // Both first touch and writes to shared code/data preserve full region
          // bounds. A write gets private RAM before Unicorn retries the access.
          return ensure(address, size, kind === uc.MEM_WRITE_UNMAPPED || kind === uc.MEM_WRITE_PROT);
        },
        read(address, size) {
          if (!ensure(address, size)) throw new Error('Read outside guest region');
          if (size > readBuffer.length) throw new Error('Guest read exceeds staging buffer');
          const output = readBuffer.subarray(0, size);
          for (let at = address, copied = 0; copied < size; ) {
            const block = find(at),
              offset = Number(at - block.begin),
              count = Math.min(size - copied, block.size - offset);
            output.set(
              uc.heapBytes().subarray(block.backing.pointer + offset, block.backing.pointer + offset + count),
              copied,
            );
            at += BigInt(count);
            copied += count;
          }
          return output;
        },
        write(address, bytes) {
          if (!ensure(address, bytes.length, true)) throw new Error('Write outside guest region');
          // Before activation, no instructions have run and no TCG blocks exist.
          // Populate the backing directly during initial image loading.
          if (!active) {
            for (let at = address, copied = 0; copied < bytes.length; ) {
              const block = find(at),
                offset = Number(at - block.begin),
                count = Math.min(bytes.length - copied, block.size - offset);
              uc.heapBytes().set(bytes.subarray(copied, copied + count), block.backing.pointer + offset);
              at += BigInt(count);
              copied += count;
            }
            return;
          }
          // Once execution may have begun, invalidate translated guest code.
          engine.mem_write(address, bytes);
        },
        seal() {
          if (sealed) return;
          sealed = true;
          for (const block of blocks) {
            const backing = block.backing;
            if (!backing || backing === zero || block.readonly) continue;
            const key = hash(backing.pointer, block.size);
            const match = [...(cache.get(key) ?? [])].find((b) => identical(b.pointer, backing.pointer, block.size));
            if (match) {
              sharingHits++;
              sharedBytes += block.size;
              match.references++;
              replace(block, match, true);
            } else {
              backing.key = key;
              if (!cache.has(key)) cache.set(key, new Set());
              cache.get(key).add(backing);
              if (active) check(uc._uc_mem_protect(handle, block.begin, BigInt(block.size), 5));
              block.readonly = true;
            }
          }
        },
        activate() {
          if (active) return;
          active = true;
          for (const block of blocks) if (block.backing) attach(block, block.backing, block.readonly);
        },
        close() {
          for (const block of blocks) release(block.backing);
          blocks.clear();
          buckets.clear();
        },
      };
      return api;
    },
  };
}
