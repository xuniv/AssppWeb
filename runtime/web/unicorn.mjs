import loadUnicorn from '../vendor/unicorn-arm64.mjs';

export async function initializeUnicorn() {
  const uc = await loadUnicorn();
  const zeros = new Uint8Array(65536);
  globalThis.assppUnicorn = {
    memoryBytes: () => uc.heapByteLength(),
    create() {
      const engine = new uc.Unicorn(uc.ARCH_ARM64, uc.MODE_ARM);
      engine.ctl_set_cpu_model(uc.CPU_ARM64_MAX);
      engine.ctl_set_tcg_buffer_size(4 * 1024 * 1024);
      const hooks = new Map();
      const lazy = [];
      const lazyBases = new Set(['52776558133248', '70368744177664', '87960930222080']);
      const mapZeroed = (address, size) => {
        engine.mem_map(address, size, uc.PROT_ALL);
        // Unicorn.js replaces anonymous mmap with aligned malloc. Recycled
        // allocations therefore contain old guest data, unlike native Unicorn.
        // Explicitly preserve zero-filled RAM/BSS semantics on every mapping.
        for (let offset = 0; offset < size; offset += zeros.length)
          engine.mem_write(address + BigInt(offset), zeros.subarray(0, Math.min(zeros.length, size - offset)));
      };
      const ensure = (address, size) => {
        const end = address + BigInt(size),
          region = lazy.find((r) => address >= r.begin && end <= r.end);
        if (!region) return false;
        for (let page = address & ~65535n; page < end; page += 65536n) {
          if (!region.pages.has(page)) {
            mapZeroed(page, 65536);
            region.pages.add(page);
          }
        }
        return true;
      };
      const faults = uc.HOOK_MEM_READ_UNMAPPED | uc.HOOK_MEM_WRITE_UNMAPPED | uc.HOOK_MEM_FETCH_UNMAPPED;
      // Go's guests declare large zero-filled heaps/stacks. Commit their pages on
      // demand so four ADI guests do not eagerly allocate hundreds of unused MiB.
      const lazyHook = engine.hook_add(faults, (_engine, _kind, at, size) => ensure(at, size));
      let events = [],
        skip = null,
        points = null,
        ranges = [],
        steps = 0;
      const counter = engine.hook_add(uc.HOOK_CODE, () => {
        steps++;
      });
      return {
        map(a, n) {
          if (lazyBases.has(a)) {
            if (lazy.some((r) => r.begin === BigInt(a))) throw new Error('Guest region already mapped');
            lazy.push({ begin: BigInt(a), end: BigInt(a) + BigInt(n), pages: new Set() });
          } else mapZeroed(BigInt(a), Number(n));
        },
        unmap(a, n) {
          const index = lazy.findIndex((r) => r.begin === BigInt(a) && r.end === BigInt(a) + BigInt(n));
          if (index >= 0) {
            for (const page of lazy[index].pages) engine.mem_unmap(page, 65536);
            lazy.splice(index, 1);
          } else engine.mem_unmap(BigInt(a), Number(n));
        },
        read(a, n) {
          ensure(BigInt(a), n);
          return engine.mem_read(BigInt(a), n);
        },
        write(a, data) {
          ensure(BigInt(a), data.length);
          engine.mem_write(BigInt(a), data);
        },
        regRead(r) {
          return BigInt.asUintN(64, engine.reg_read_i64(r)).toString();
        },
        regWrite(r, v) {
          engine.reg_write_i64(r, BigInt.asIntN(64, BigInt(v)));
        },
        regRead128(r) {
          return engine.reg_read(r, 16);
        },
        regWrite128(r, v) {
          engine.reg_write(r, v);
        },
        hook(id, a, b) {
          hooks.set(
            id,
            engine.hook_add(
              uc.HOOK_CODE,
              (_engine, at, size) => {
                if (
                  a === '0' &&
                  b === '18446744073709551615' &&
                  points &&
                  !points.has(at.toString()) &&
                  ranges.some(([lo, hi]) => at >= lo && at < hi)
                )
                  return;
                const key = `${id}:${at}`;
                if (skip?.has(key)) {
                  skip.delete(key);
                  return;
                }
                events.push({ id, address: at.toString(), size });
                engine.emu_stop();
              },
              {},
              BigInt(a),
              BigInt(b),
            ),
          );
        },
        memoryHook(id) {
          hooks.set(
            id,
            engine.hook_add(faults, (_engine, _kind, at, size) => {
              if (ensure(at, size)) return true;
              events.push({ id, address: at.toString(), size });
              engine.emu_stop();
              return false;
            }),
          );
        },
        removeHook(id) {
          if (hooks.has(id)) {
            engine.hook_del(hooks.get(id));
            hooks.delete(id);
          }
        },
        policy(p, regions) {
          points = new Set(p);
          ranges = regions.map(([a, b]) => [BigInt(a), BigInt(b)]);
        },
        start(a, b, count) {
          // A host callback often redirects PC to its return address. In that
          // case there is no intercepted instruction to replay: carrying its
          // skip token forward would suppress the next genuine call to the same
          // stub. Keep tokens only when resuming that exact instruction.
          if (skip) skip = new Set([...skip].filter((key) => key.endsWith(`:${BigInt(a)}`)));
          events = [];
          steps = 0;
          let error = '';
          try {
            engine.emu_start(BigInt(a), BigInt(b), 0n, Math.min(Number(count) || 100000, 100000));
          } catch (err) {
            error = String(err);
          }
          // Replay the intercepted instruction only after the Go bridge has returned.
          // Guest callbacks can then await network I/O without blocking a JS stack.
          skip = new Set(events.map((event) => `${event.id}:${event.address}`));
          return { events, error: events.length ? '' : error, steps };
        },
        close() {
          engine.hook_del(counter);
          engine.hook_del(lazyHook);
          engine.close();
          hooks.clear();
          lazy.length = 0;
        },
      };
    },
  };
}
