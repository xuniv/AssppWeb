import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { chromium, webkit } from '../../frontend/node_modules/playwright/index.mjs';

const directory = path.resolve(process.argv[2] ?? 'frontend/public/store-runtime');
const liveApple = process.env.LIVE_APPLE === '1';
const provisioning = process.env.PROVISION_APPLE === '1';
let wisp;
if (liveApple) {
  ({ server: wisp } = await import('../../backend/node_modules/@mercuryworkshop/wisp-js/src/entrypoints/server.mjs'));
  wisp.options.hostname_whitelist = [
    /^init\.itunes\.apple\.com$/,
    /^s\.mzstatic\.com$/,
    /^fpinit\.itunes\.apple\.com$/,
    /^gsa\.apple\.com$/,
    /^www\.apple\.com$/,
  ];
  wisp.options.port_whitelist = [443];
}
assert(existsSync(path.join(directory, 'runtime.wasm')), 'Build the client bundle before running this check');
const sockets = new Set();
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Local Store runtime check</title>');
    return;
  }
  const relative = decodeURIComponent(url.pathname).replace(/^\/store-runtime\//, '');
  const file = path.resolve(directory, relative);
  if (!file.startsWith(directory + path.sep)) {
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
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});
server.on('upgrade', (req, socket) => {
  if (wisp) {
    wisp.routeRequest(req, socket, Buffer.alloc(0));
    return;
  }
  const accept = createHash('sha1')
    .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  // The offline check never opens an Apple connection. Only Wisp's initial
  // flow-control message is needed to keep the worker transport ready.
  socket.write(Buffer.from([0x82, 9, 3, 0, 0, 0, 0, 0xff, 0xff, 0, 0]));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
try {
  for (const name of (process.env.BROWSERS ?? 'chromium').split(',')) {
    const type = name === 'webkit' ? webkit : chromium;
    const browserServer = await type.launchServer({
      headless: true,
      ...(name === 'chromium' && process.env.CHROMIUM_PATH
        ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] }
        : {}),
    });
    const browser = await type.connect(browserServer.wsEndpoint());
    let peakContentKiB = 0;
    const sample = () => {
      try {
        const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,rss=,args='], { encoding: 'utf8' })
          .split('\n')
          .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
          .filter(Boolean);
        const descendants = new Set([browserServer.process().pid]);
        for (let pass = 0; pass < 8; pass++)
          for (const row of rows) if (descendants.has(Number(row[2]))) descendants.add(Number(row[1]));
        for (const row of rows)
          if (descendants.has(Number(row[1])) && /--type=renderer|(?:WebKit|WPE)WebProcess/.test(row[4]))
            peakContentKiB = Math.max(peakContentKiB, Number(row[3]));
      } catch {
        /* RSS measurement is optional outside Unix CI. */
      }
    };
    const monitor = setInterval(sample, 200);
    try {
      const page = await browser.newPage();
      await page.exposeFunction('reportStage', (stage) => {
        sample();
        console.log(name + ': ' + stage + ` (peak RSS ${peakContentKiB} KiB)`);
      });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${address.port}`);
      const output = await page.evaluate(
        async ({ liveApple, provisioning }) => {
          const worker = new Worker('/store-runtime/store-runtime.js');
          let id = 1,
            writes = 0,
            bytes = 0;
          const jobs = new Map();
          worker.onmessage = ({ data }) => {
            if (data.type === 'fatal') {
              for (const job of jobs.values()) job.reject(new Error('Runtime initialization failed'));
            }
            if (data.type === 'host') {
              if (data.method === 'writeAsset') {
                writes++;
                bytes += data.payload.bytes.byteLength;
              }
              worker.postMessage({ type: 'reply', id: data.id, value: null });
            }
            if (data.type === 'result') {
              const job = jobs.get(data.id);
              jobs.delete(data.id);
              if (data.error) job.reject(new Error(data.error));
              else job.resolve(JSON.parse(data.value));
            }
            if (data.type === 'statistics') {
              jobs.get('statistics').resolve(data.value);
              jobs.delete('statistics');
            }
          };
          worker.onerror = () => {
            for (const job of jobs.values()) job.reject(new Error('Worker failed'));
          };
          worker.postMessage({ type: 'initialize', wispURL: `ws://${location.host}/wisp/` });
          const run = (operation) =>
            new Promise((resolve, reject) => {
              const job = id++;
              jobs.set(job, { resolve, reject });
              worker.postMessage({
                type: 'run',
                id: job,
                input: JSON.stringify({ operation, deviceID: '020000000001' }),
              });
            });
          try {
            const results = [];
            const operations = liveApple
              ? ['network-preflight', 'sap-test']
              : [
                  'bridge-preflight',
                  'memory-preflight',
                  'preflight',
                  ...Array(3).fill('adi-preflight'),
                  'framework-preflight',
                ];
            if (provisioning) operations.push('anisette-preflight');
            for (const operation of operations) {
              await reportStage(operation);
              const result = await run(operation);
              results.push({ operation, result });
              await reportStage(operation + ' complete');
              if (!result.ok) break;
            }
            const statistics = await new Promise((resolve, reject) => {
              jobs.set('statistics', { resolve, reject });
              worker.postMessage({ type: 'statistics' });
            });
            return { results, statistics, writes, bytes };
          } finally {
            worker.terminate();
          }
        },
        { liveApple, provisioning },
      );
      console.log(JSON.stringify({ browser: name, peakContentKiB, ...output }));
      for (const item of output.results)
        assert.equal(item.result.ok, true, `${name} ${item.operation}: ${item.result.error}`);
      assert.equal(output.writes, 0);
      assert.equal(output.bytes, 0);
      assert.equal(output.statistics.workspaceBytes, 0);
      assert(
        output.statistics.goBytes + output.statistics.emulatorBytes < 640 * 1024 * 1024,
        'Interpreter memory exceeded the iOS budget',
      );
      assert(peakContentKiB > 0 && peakContentKiB < 768 * 1024, 'WebContent peak RSS exceeded the mobile budget');
      assert.deepEqual(errors, []);
    } finally {
      clearInterval(monitor);
      await browser.close();
      await browserServer.close();
    }
  }
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
}
