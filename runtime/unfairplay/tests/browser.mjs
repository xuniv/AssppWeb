import assert from 'node:assert/strict';
import { chromium, webkit } from '../../../frontend/node_modules/playwright/index.mjs';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const bundle = process.argv[2] ?? 'frontend/public/unfairplay';
const fixtures = process.argv[3];
assert(fixtures, 'Supply the synthetic fixture directory');
const server = createServer(async (req, res) => {
  let file;
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Private synthetic UnfairPlay test</title>');
    return;
  }
  if (url.pathname === '/unfairplay/memory-storage-control.js')
    file = fileURLToPath(new URL('./memory-storage-control.js', import.meta.url));
  else if (url.pathname.startsWith('/unfairplay/')) file = bundle + '/' + url.pathname.split('/').pop();
  else if (url.pathname === '/api/synthetic') file = fixtures + `/synthetic-${url.searchParams.get('size') ?? '0'}.ipa`;
  else if (url.pathname === '/model')
    file = fixtures + (url.searchParams.get('conversion') === '1' ? '/conversion-model.bin' : '/model.bin');
  else {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    const info = await stat(file);
    res.setHeader('Content-Length', info.size);
    res.setHeader(
      'Content-Type',
      file.endsWith('.js')
        ? 'text/javascript'
        : file.endsWith('.wasm')
          ? 'application/wasm'
          : 'application/octet-stream',
    );
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
try {
  for (const name of (process.env.BROWSERS ?? 'chromium,webkit').split(',')) {
    const type = name === 'webkit' ? webkit : chromium;
    const launch = await type.launchServer({
      headless: true,
      ...(name === 'webkit' && process.env.WEBKIT_STORAGE_FEATURES === '1'
        ? { args: ['--features=FileSystem,StorageAPI,StorageAPIEstimate,FileSystemHandleSerialization'] }
        : {}),
      ...(name === 'chromium' && process.env.CHROMIUM_PATH
        ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] }
        : {}),
    });
    const browser = await type.connect(launch.wsEndpoint());
    let peakKiB = 0;
    const sample = () => {
      try {
        const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,rss=,args='], { encoding: 'utf8' })
          .split('\n')
          .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
          .filter(Boolean);
        const pids = new Set([launch.process().pid]);
        for (let i = 0; i < 8; i++) for (const r of rows) if (pids.has(Number(r[2]))) pids.add(Number(r[1]));
        for (const r of rows)
          if (pids.has(Number(r[1])) && /--type=renderer|(?:WebKit|WPE)WebProcess/.test(r[4]))
            peakKiB = Math.max(peakKiB, Number(r[3]));
      } catch {}
    };
    const timer = setInterval(sample, 250);
    try {
      const page = await browser.newPage();
      page.on('pageerror', (e) => console.log(name + ': page error ' + e.message));
      await page.goto(`http://localhost:${server.address().port}/`);
      const rows = [];
      const cases = (
        process.env.CASES ?? 'model_inspect:0,doctor:0,verify:0,decrypt:0,strip_account_data:0,decrypt:64,verify:128'
      ).split(',');
      for (const item of cases) {
        const [operation, mb] = item.split(':');
        const start = Date.now();
        const value = await page.evaluate(
          async ({ operation, mb, memoryControl, expectUnsupported }) => {
            const worker = new Worker(
              memoryControl ? '/unfairplay/memory-storage-control.js' : '/unfairplay/unfairplay-worker.js',
            );
            const directory = 'asspp-unfairplay-' + crypto.randomUUID();
            let initializedMs;
            const begin = performance.now();
            let result;
            let privateInputsTransferred = false;
            try {
              result = await new Promise((resolve, reject) => {
                worker.onerror = () => reject(new Error('worker failure'));
                worker.onmessage = async ({ data }) => {
                  if (data.type === 'error') {
                    reject(new Error(data.code));
                    return;
                  }
                  if (data.type === 'ready') {
                    initializedMs = performance.now() - begin;
                    const model = await (
                      await fetch(operation === 'convert_ipa_macos' ? '/model?conversion=1' : '/model')
                    ).blob();
                    privateInputsTransferred = true;
                    worker.postMessage({
                      type: 'run',
                      operation,
                      input:
                        operation === 'model_inspect' ? undefined : { url: '/api/synthetic?size=' + mb, headers: {} },
                      models: operation === 'strip_account_data' || operation === 'doctor' ? [] : [model],
                      stripAccountData: false,
                    });
                  }
                  if (data.type === 'result') resolve(data);
                };
                worker.postMessage({ type: 'initialize', directory, operation });
              });
              const report = JSON.parse(await result.report.text());
              if (result.ipa) {
                const stream = result.ipa.stream().getReader();
                let total = 0;
                for (;;) {
                  const item = await stream.read();
                  if (item.done) break;
                  total += item.value.length;
                }
                if (total !== result.ipa.size) throw new Error('unreadable output snapshot');
              }
              return {
                operation,
                mb: Number(mb),
                initializedMs,
                milliseconds: performance.now() - begin,
                summary: result.summary,
                report,
                outputBytes: result.ipa?.size ?? 0,
              };
            } catch (error) {
              if (expectUnsupported && error.message.includes('unfairplay_browser_unsupported'))
                return { operation, unsupported: true, privateInputsTransferred };
              throw error;
            } finally {
              worker.terminate();
              if (navigator.storage?.getDirectory) {
                const root = await navigator.storage.getDirectory();
                await root.removeEntry(directory, { recursive: true }).catch(() => {});
              }
            }
          },
          {
            operation,
            mb,
            memoryControl: process.env.MEMORY_STORAGE_CONTROL === '1',
            expectUnsupported: process.env.EXPECT_UNSUPPORTED === '1',
          },
        );
        sample();
        rows.push({ ...value, wallMs: Date.now() - start, peakKiB });
        console.log(
          JSON.stringify({
            browser: name,
            storageBackend: process.env.MEMORY_STORAGE_CONTROL === '1' ? 'test-only-paged-memory' : 'production-opfs',
            ...rows.at(-1),
          }),
        );
        if (value.unsupported) {
          assert.equal(value.privateInputsTransferred, false);
          continue;
        }
        if (operation === 'decrypt' || operation === 'verify') assert.equal(value.summary.plaintextVerified, true);
        assert(!JSON.stringify(value.report).includes('sha256'));
      }
      await writeFile(
        `/tmp/unfair-browser-${name}-result.json`,
        JSON.stringify({ browser: name, peakKiB, rows }, null, 2),
      );
    } finally {
      clearInterval(timer);
      await browser.close();
      await launch.close();
    }
  }
} finally {
  await new Promise((r) => server.close(r));
}
