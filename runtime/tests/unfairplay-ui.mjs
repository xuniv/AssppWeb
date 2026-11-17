// Actual UI + actual local WASM on a generated synthetic IPA/model. The server
// branch below is a transport fixture; native HTTP execution has separate tests.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { webkit, chromium } from '../../frontend/node_modules/playwright/index.mjs';

const appDirectory = path.resolve(process.argv[2] ?? '/tmp/asspp-unfair-ui-dist');
const runtimeDirectory = path.resolve(process.argv[3] ?? '/tmp/unfair-browser-bundle');
const fixtureDirectory = path.resolve(process.argv[4] ?? '/tmp/unfair-browser-fixtures');
const artifacts = '/tmp/asspp-unfair-ui-artifacts';
await mkdir(artifacts, { recursive: true });
const ipaPath = path.join(fixtureDirectory, 'synthetic-0.ipa');
const modelPath = path.join(fixtureDirectory, 'model.bin');
const ipa = await readFile(ipaPath);
const originalDigest = createHash('sha256').update(ipa).digest('hex');
const email = 'synthetic@example.test';
const accountHash = createHash('sha256').update(email).digest('hex');
let sourceReads = 0,
  serverCalls = 0,
  serverCancelled = false,
  delayServer = false;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (value) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(value));
  };
  if (url.pathname === '/api/auth/status') return json({ required: false });
  if (url.pathname === '/api/settings') return json({ serverUnfairplayAvailable: true });
  if (url.pathname === '/api/downloads')
    return json([
      {
        id: 'fixture',
        accountHash,
        status: 'completed',
        progress: 100,
        hasFile: true,
        createdAt: '2026-01-01T00:00:00Z',
        software: {
          id: 1,
          name: 'Synthetic',
          bundleID: 'com.example.synthetic',
          version: '1',
          artistName: 'Fixture',
          sellerName: 'Fixture',
          artworkUrl: '',
          screenshotUrls: [],
          fileSizeBytes: String(ipa.length),
          minimumOsVersion: '16',
          releaseDate: '2026-01-01',
          primaryGenreName: 'Utilities',
        },
      },
    ]);
  if (url.pathname === '/api/uploads')
    return json([
      {
        id: 'upload-fixture',
        software: { name: 'Synthetic upload', bundleID: 'com.example.synthetic', version: '1' },
        fileSize: ipa.length,
        installUrl: 'itms-services://fixture',
      },
    ]);
  if (url.pathname.startsWith('/api/packages/') || url.pathname.endsWith('/payload.ipa')) {
    sourceReads++;
    res.setHeader('Content-Type', 'application/octet-stream');
    return res.end(ipa);
  }
  if (url.pathname.startsWith('/api/unfairplay/')) {
    serverCalls++;
    assert.equal(req.headers['x-asspp-unfairplay-consent'], 'model-v1');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = new Request('http://localhost' + req.url, {
      method: 'POST',
      headers: req.headers,
      body: Buffer.concat(chunks),
    });
    const form = await request.formData();
    assert.deepEqual(JSON.parse(form.get('source')), { kind: 'upload', id: 'upload-fixture' });
    assert.equal(form.get('ipa'), null);
    assert.equal(form.getAll('models').length, 0);
    if (delayServer) {
      res.on('close', () => {
        serverCancelled = true;
      });
      return;
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader(
      'X-Asspp-Unfairplay-Summary',
      Buffer.from(JSON.stringify({ accountDataStripped: true, removedLicenseFiles: 2 })).toString('base64url'),
    );
    return res.end('synthetic server output');
  }
  let file = url.pathname.startsWith('/unfairplay/')
    ? path.join(runtimeDirectory, path.basename(url.pathname))
    : path.join(appDirectory, url.pathname.replace(/^\//, ''));
  try {
    let content;
    try {
      content = await readFile(file);
    } catch {
      file = path.join(appDirectory, 'index.html');
      content = await readFile(file);
    }
    res.setHeader(
      'Content-Type',
      file.endsWith('.js')
        ? 'text/javascript'
        : file.endsWith('.wasm')
          ? 'application/wasm'
          : file.endsWith('.css')
            ? 'text/css'
            : file.endsWith('.png')
              ? 'image/png'
              : 'text/html',
    );
    res.end(content);
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const name = process.env.UI_BROWSER ?? 'chromium';
const browser = await (name === 'webkit' ? webkit : chromium).launch({
  headless: true,
  ...(name === 'chromium' ? { executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] } : {}),
});
const page = await browser.newPage({ locale: 'en-US', viewport: { width: 390, height: 844 }, acceptDownloads: true });
await page.addInitScript(() => {
  window.__unfairWorkers = 0;
  window.__unfairWorkerErrors = [];
  window.__modelVersions = [];
  window.__idbErrors = [];
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) {
    try {
      const request = put.apply(this, args);
      request.addEventListener('error', () => window.__idbErrors.push(request.error?.name));
      return request;
    } catch (error) {
      window.__idbErrors.push(error.name);
      throw error;
    }
  };
  window.Worker = new Proxy(window.Worker, {
    construct(target, args) {
      window.__unfairWorkers++;
      const worker = Reflect.construct(target, args);
      worker.addEventListener('message', ({ data }) => {
        if (data.type === 'error') window.__unfairWorkerErrors.push(data.code);
        if (data.type === 'result')
          window.__modelVersions.push(
            data.summary?.modelVersions ?? data.summary?.models?.map((model) => model.version),
          );
      });
      worker.addEventListener('error', () => window.__unfairWorkerErrors.push('worker_script_error'));
      return worker;
    },
  });
});
try {
  await page.goto(origin + '/unfairplay');
  await page.getByLabel('IPA file', { exact: true }).setInputFiles(ipaPath);
  await page.getByLabel('Import multi.bin models', { exact: true }).setInputFiles(modelPath);
  await Promise.race([
    page.getByRole('checkbox', { name: /model.bin/ }).waitFor(),
    page
      .getByText('Model import failed. Choose supported, valid multi.bin files.', { exact: true })
      .waitFor()
      .then(() => {
        throw new Error('Synthetic model import failed');
      }),
  ]);
  await page.reload();
  await page.getByRole('checkbox', { name: /model.bin/ }).waitFor();
  await page.getByRole('checkbox', { name: /model.bin/ }).check();
  await page.getByLabel('IPA file', { exact: true }).setInputFiles(ipaPath);
  assert.equal(await page.getByRole('switch').isChecked(), false);
  const localArchivesAvailable = await page.evaluate(() => Boolean(navigator.storage?.getDirectory));
  await page.getByRole('combobox').selectOption('verify');
  await page.getByRole('button', { name: 'Verify decryption', exact: true }).click();
  if (localArchivesAvailable) {
    await page.getByText('Operation completed.', { exact: true }).waitFor();
    const reportEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download report', exact: true }).click();
    const reportDownload = await reportEvent;
    await reportDownload.saveAs(path.join(artifacts, 'safe-summary.json'));
    const report = JSON.parse(await readFile(path.join(artifacts, 'safe-summary.json'), 'utf8'));
    assert.equal(report.plaintextVerified, true);
    const summaryKeys = new Set([
      'plaintextVerified',
      'accountDataStripped',
      'ready',
      'registryCompatible',
      'encryptedImages',
      'decryptedPages',
      'removedLicenseFiles',
      'removedMetadataFields',
      'modelCount',
      'modelVersions',
      'convertedRecords',
      'convertedReplicas',
    ]);
    assert(
      Object.keys(report).every((key) => summaryKeys.has(key)),
      'Private evidence escaped into the UI report',
    );
    await page.getByRole('combobox').selectOption('strip_account_data');
    await page.getByRole('button', { name: 'Strip account data', exact: true }).click();
    await page.getByText('Operation completed.', { exact: true }).waitFor();
    const outputEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download new IPA', exact: true }).click();
    await (await outputEvent).saveAs(path.join(artifacts, 'stripped.ipa'));
    execFileSync('python3', [
      '-c',
      `import zipfile,plistlib,sys
with zipfile.ZipFile(sys.argv[1]) as z:
 assert not any('SC_Info' in n.split('/') for n in z.namelist())
 metadata=plistlib.loads(z.read('iTunesMetadata.plist'))
 assert 'apple-id' not in metadata and 'userName' not in metadata
`,
      path.join(artifacts, 'stripped.ipa'),
    ]);
    assert.equal(
      createHash('sha256')
        .update(await readFile(ipaPath))
        .digest('hex'),
      originalDigest,
    );
    assert.equal(serverCalls, 0, 'Device operations transferred to the server');
    await page.screenshot({ path: path.join(artifacts, 'local-result.png'), fullPage: true });
  } else {
    await page
      .getByText('Device processing is unavailable in this browser. You can explicitly choose server processing.', {
        exact: true,
      })
      .waitFor();
    assert.equal(serverCalls, 0, 'Unsupported local processing silently fell back to a server');
  }

  // Seed a synthetic account solely so the ordinary downloaded-package UI can
  // resolve its accountHash and discover the read-only fixture task.
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('asspp-accounts', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('accounts', { keyPath: 'email' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = db.transaction('accounts', 'readwrite');
    transaction.objectStore('accounts').put({
      email: 'synthetic@example.test',
      firstName: 'Synthetic',
      store: '143441',
      deviceIdentifier: '020000000001',
    });
    await new Promise((resolve) => {
      transaction.oncomplete = resolve;
    });
    db.close();
  });
  await page.goto(origin + '/downloads/fixture');
  await page.getByRole('button', { name: 'UnfairPlay', exact: true }).click();
  if (localArchivesAvailable) {
    await page.getByRole('combobox').selectOption('strip_account_data');
    await page.getByRole('button', { name: 'Strip account data', exact: true }).click();
    await page.getByText('Operation completed.', { exact: true }).waitFor();
    assert.equal(sourceReads, 1, 'Existing IPA was not streamed directly to the local worker');
    assert.equal(serverCalls, 0);
  }

  await page.goto(origin + '/uploads');
  await page.getByRole('button', { name: 'UnfairPlay', exact: true }).click();
  await page.getByRole('combobox').selectOption('strip_account_data');
  await page.getByRole('switch', { name: 'Process on this server' }).check();
  await page
    .getByText(
      'When on, this server’s operator can access this IPA and the selected private models for this operation.',
      { exact: true },
    )
    .waitFor();
  await page.screenshot({ path: path.join(artifacts, `${name}-server-panel.png`), fullPage: true });
  await page.getByRole('button', { name: 'Strip account data', exact: true }).click();
  await page.getByText('Operation completed.', { exact: true }).waitFor();
  assert.equal(sourceReads, localArchivesAvailable ? 1 : 0, 'Server source was redundantly fetched into the browser');
  assert.equal(serverCalls, 1);
  delayServer = true;
  const workers = await page.evaluate(() => window.__unfairWorkers);
  await page.getByRole('button', { name: 'Strip account data', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).waitFor();
  await page.getByRole('switch', { name: 'Process on this server' }).uncheck();
  await page.getByText('Operation cancelled. The original was not changed.', { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => window.__unfairWorkers),
    workers,
    'Server cancellation fell back to a client worker',
  );
  await page.waitForTimeout(100);
  assert.equal(serverCancelled, true);
  console.log(
    JSON.stringify({
      browser: name,
      actualWasmModelImport: true,
      modelPersisted: true,
      actualWasmVerify: localArchivesAvailable,
      actualWasmStrip: localArchivesAvailable,
      unsupportedDeviceRejectedWithoutFallback: !localArchivesAvailable,
      privateSummaryDownloadVerified: localArchivesAvailable,
      originalPreserved: true,
      existingSourceReads: sourceReads,
      serverCalls,
      serverCancelled,
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify(
      await page.evaluate(() => ({
        workerErrors: window.__unfairWorkerErrors,
        modelVersions: window.__modelVersions,
        idbErrors: window.__idbErrors,
        workers: window.__unfairWorkers,
        secure: isSecureContext,
        crypto: Boolean(crypto.subtle),
        opfs: Boolean(navigator.storage?.getDirectory),
      })),
    ),
  );
  await page.screenshot({ path: path.join(artifacts, `${name}-failure.png`), fullPage: true });
  throw error;
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
