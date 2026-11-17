import loadUnicorn from '../vendor/unicorn-arm64.mjs';
import { sharedMemory } from './memory.mjs';

export async function initializeUnicorn() {
  const uc = await loadUnicorn();
  const pool = sharedMemory(uc);
  globalThis.assppUnicorn = {
    memoryBytes: () => uc.heapByteLength(),
    memoryStatistics: pool.statistics,
    create() {
      const engine = new uc.Unicorn(uc.ARCH_ARM64, uc.MODE_ARM);
      engine.ctl_set_cpu_model(uc.CPU_ARM64_MAX);
      engine.ctl_set_tcg_buffer_size(1024 * 1024);
      const memory = pool.create(engine);
      const hooks = new Map();
      const broadHooks = new Set();
      const faults =
        uc.HOOK_MEM_READ_UNMAPPED | uc.HOOK_MEM_WRITE_UNMAPPED | uc.HOOK_MEM_FETCH_UNMAPPED | uc.HOOK_MEM_WRITE_PROT;
      // Go's guests declare large zero-filled heaps/stacks. Commit their pages on
      // demand so four ADI guests do not eagerly allocate hundreds of unused MiB.
      let pendingFault = null;
      const repairLater = (kind, at, size) => {
        if (!memory.covers(at, size)) return false;
        pendingFault = { kind, at, size };
        engine.emu_stop();
        return true;
      };
      // Replacing a protected mapping inside Unicorn's memory callback leaves
      // the active load/store with a stale MemoryRegion pointer. Repair only
      // after uc_emu_start has unwound, then retry the same instruction.
      const lazyHook = engine.hook_add(faults, (_engine, kind, at, size) => {
        repairLater(kind, at, size);
        return false;
      });
      let events = [],
        skip = null,
        points = null,
        ranges = [],
        steps = 0;
      let counter = null;
      return {
        seal: memory.seal,
        map(a, n) {
          memory.map(BigInt(a), Number(n));
        },
        unmap(a, n) {
          memory.unmap(BigInt(a), Number(n));
        },
        read(a, n) {
          return memory.read(BigInt(a), n);
        },
        write(a, data) {
          memory.write(BigInt(a), data);
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
          const broad = a === '0' && b === '18446744073709551615';
          if (broad) broadHooks.add(id);
          hooks.set(
            id,
            engine.hook_add(
              uc.HOOK_CODE,
              (_engine, at, size) => {
                if (broad) steps++;
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
            engine.hook_add(faults, (_engine, kind, at, size) => {
              if (repairLater(kind, at, size)) return false;
              events.push({ id, address: at.toString(), size });
              engine.emu_stop();
              return false;
            }),
          );
        },
        removeHook(id) {
          broadHooks.delete(id);
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
          memory.seal();
          memory.activate();
          // SAP uses wall-time limits and needs no JS callback per instruction.
          // The framework already has a broad validation hook: count there.
          // Keep a separate counter only for bounded synthetic/other engines.
          if (Number(count) > 0 && !broadHooks.size && !counter)
            counter = engine.hook_add(uc.HOOK_CODE, () => {
              steps++;
            });
          else if (broadHooks.size && counter) {
            engine.hook_del(counter);
            counter = null;
          }
          // A host callback often redirects PC to its return address. In that
          // case there is no intercepted instruction to replay: carrying its
          // skip token forward would suppress the next genuine call to the same
          // stub. Keep tokens only when resuming that exact instruction.
          if (skip) skip = new Set([...skip].filter((key) => key.endsWith(`:${BigInt(a)}`)));
          const replay = skip ? [...skip] : [];
          events = [];
          pendingFault = null;
          steps = 0;
          let error = '';
          try {
            engine.emu_start(BigInt(a), BigInt(b), 0n, Math.min(Number(count) || 100000, 100000));
          } catch (err) {
            error = String(err);
          }
          if (pendingFault && memory.fault(pendingFault.kind, pendingFault.at, pendingFault.size)) error = '';
          // Replay the intercepted instruction only after the Go bridge has returned.
          // Guest callbacks can then await network I/O without blocking a JS stack.
          // A protected-page fault retries the same uncompleted instruction.
          // Keep its already-delivered callbacks suppressed across that retry.
          skip = new Set([...(pendingFault ? replay : []), ...events.map((event) => `${event.id}:${event.address}`)]);
          return { events, error: events.length ? '' : error, steps };
        },
        close() {
          if (counter) engine.hook_del(counter);
          engine.hook_del(lazyHook);
          for (const hook of hooks.values()) engine.hook_del(hook);
          engine.close();
          memory.close();
          hooks.clear();
        },
      };
    },
  };
}
