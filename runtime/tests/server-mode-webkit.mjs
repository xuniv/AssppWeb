// Real WebKit UI + actual Express route + a deliberately synthetic stdio helper.
// No Apple service is contacted and the fixture never accepts a real account.
// Run after building frontend/dist, using Node 24 and the backend tsx loader:
// node --import ./backend/node_modules/tsx/dist/loader.mjs runtime/tests/server-mode-webkit.mjs /path/to/frontend/dist
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from '../../backend/node_modules/express/index.js';
import { webkit } from '../../frontend/node_modules/playwright/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const directory = path.resolve(process.argv[2] ?? path.join(root, 'frontend/dist'));
const artifacts = path.resolve(
  process.env.SERVER_WEBKIT_ARTIFACTS ?? path.join(tmpdir(), 'asspp-server-webkit-artifacts'),
);
const fixture = await mkdtemp(path.join(tmpdir(), 'asspp-server-webkit-fixture-'));
const helper = path.join(fixture, 'synthetic-worker');
const consent = 'Process Apple requests on this server';
const trust =
  'When on, this server’s operator can access your Apple ID, password, 2FA codes, tokens and cookies for all accounts.';
const accessPassword = 'synthetic-access-only';
const accessToken = createHash('sha256').update(accessPassword).digest('hex');
await mkdir(artifacts, { recursive: true });
await writeFile(
  helper,
  `#!${process.execPath}
const fs=require('node:fs');const path=require('node:path');
let input='';process.stdin.on('data',v=>input+=v);process.stdin.on('end',()=>{
 const q=JSON.parse(input);
 if(q.operation!=='login'||!String(q.email).endsWith('@example.test')||q.password!=='synthetic-password')process.exit(2);
 const reply=v=>process.stdout.write(JSON.stringify(v));
 const state={records:{syntheticFixture:'Zml4dHVyZQ=='},cookies:[]};
 if(q.email==='delay@example.test'){
  fs.writeFileSync(path.join(process.argv[3],'delayed-pid'),String(process.pid));
  setTimeout(()=>reply({ok:false,error:'operation_failed',state}),30000);return;
 }
 if(q.email==='failure@example.test')process.exit(3);
 if(!q.code){reply({ok:false,error:'verification_required',state});return;}
 if(q.code!=='123456'||q.state?.records?.syntheticFixture!=='Zml4dHVyZQ==')process.exit(4);
 reply({ok:true,state,value:{email:q.email,passwordToken:'synthetic-token',directoryServicesIdentifier:'1000000000',name:'Synthetic Fixture',storeFront:'143441-1,29',pod:'25'}});
});
`,
  { mode: 0o700 },
);
process.env.ACCESS_PASSWORD = accessPassword;
process.env.SERVER_STORE_RUNTIME_ENABLED = 'true';
process.env.SERVER_STORE_RUNTIME_PATH = helper;
process.env.SERVER_STORE_RUNTIME_ASSETS = fixture;
const [{ default: runtimeRoutes }, { default: settingsRoutes }, { default: authRoutes }, { accessAuth }] =
  await Promise.all([
    import('../../backend/src/routes/storeRuntime.ts'),
    import('../../backend/src/routes/settings.ts'),
    import('../../backend/src/routes/auth.ts'),
    import('../../backend/src/middleware/accessAuth.ts'),
  ]);
const app = express();
app.use('/api', accessAuth);
app.use('/api', runtimeRoutes);
app.use(express.json());
app.use('/api', authRoutes);
app.use('/api', settingsRoutes);
app.get('/api/downloads', (_req, res) => res.json([]));
app.use(express.static(directory));
app.get('*', (_req, res) => res.sendFile(path.join(directory, 'index.html')));
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browserServer = await webkit.launchServer({ headless: true });
const browser = await webkit.connect(browserServer.wsEndpoint());
let peakContentKiB = 0;
let serverModePeakKiB = 0;
let measuringServerMode = false;
function sample() {
  const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,rss=,args='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean);
  const descendants = new Set([browserServer.process().pid]);
  for (let pass = 0; pass < 8; pass++)
    for (const row of rows) if (descendants.has(Number(row[2]))) descendants.add(Number(row[1]));
  for (const row of rows)
    if (descendants.has(Number(row[1])) && /(?:WebKit|WPE)WebProcess/.test(row[4])) {
      peakContentKiB = Math.max(peakContentKiB, Number(row[3]));
      if (measuringServerMode) serverModePeakKiB = Math.max(serverModePeakKiB, Number(row[3]));
    }
}
const monitor = setInterval(sample, 100);
const results = [];
async function until(check, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}
async function instrument(context) {
  await context.addInitScript(() => {
    window.__runtimeProbe = { workers: 0, wasm: 0 };
    window.Worker = new Proxy(window.Worker, {
      construct() {
        window.__runtimeProbe.workers++;
        throw new Error('synthetic_worker_guard');
      },
    });
    for (const method of ['compile', 'instantiate', 'compileStreaming', 'instantiateStreaming']) {
      if (WebAssembly[method])
        WebAssembly[method] = new Proxy(WebAssembly[method], {
          apply(target, self, args) {
            window.__runtimeProbe.wasm++;
            return Reflect.apply(target, self, args);
          },
        });
    }
  });
}
async function openLocal(context, route = '/accounts/add') {
  const page = await context.newPage();
  await page.goto(origin + route);
  await page.getByPlaceholder('Enter access password').fill(accessPassword);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await page.getByRole('heading', { name: 'Add Account', exact: true }).waitFor();
  return page;
}
async function addInputs(page, email) {
  await page.locator('#email').fill(email);
  await page.locator('#password').fill('synthetic-password');
  await page.locator('#deviceId').fill('020000000001');
}
async function toggleServer(page, enabled) {
  const control = page.getByRole('switch', { name: consent });
  if ((await control.isChecked()) !== enabled) await page.getByText(consent, { exact: true }).click();
  assert.equal(await control.isChecked(), enabled);
}
let defaultBrowser;
try {
  // Fresh browsers remain client-only until the explicit login switch is used.
  // A separate process keeps this client-mode positive control out of the
  // server-only RSS measurement and its retained browser caches.
  defaultBrowser = await webkit.launch({ headless: true });
  const defaults = await defaultBrowser.newContext({ locale: 'en-US' });
  await instrument(defaults);
  const defaultRequests = [];
  defaults.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/store-runtime') defaultRequests.push(request);
  });
  const defaultPage = await openLocal(defaults);
  assert.equal(await defaultPage.getByRole('switch', { name: consent }).isChecked(), false);
  assert.equal(await defaultPage.evaluate(() => window.__runtimeProbe.workers), 0);
  await addInputs(defaultPage, 'default@example.test');
  await defaultPage.getByRole('button', { name: 'Sign In', exact: true }).click();
  await until(
    () => defaultPage.evaluate(() => window.__runtimeProbe.workers === 1),
    'Client mode did not attempt its worker',
  );
  assert.equal(defaultRequests.length, 0);
  results.push('client is default; client login does not transfer to server');
  await defaults.close();
  await defaultBrowser.close();

  measuringServerMode = true;
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 390, height: 844 } });
  await instrument(context);
  const runtimeRequests = [];
  const heavyResources = [];
  const pageErrors = [];
  context.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/store-runtime') runtimeRequests.push(request);
    if (pathname.startsWith('/store-runtime/') || /\.wasm$|\.zlib$/.test(pathname)) heavyResources.push(pathname);
  });
  const page = await openLocal(context);
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const checkbox = page.getByRole('switch', { name: consent });
  await until(() => checkbox.isEnabled(), 'Synthetic helper was not available');
  assert.equal(await checkbox.isChecked(), false);
  const denied = await page.evaluate(async () => {
    const result = await fetch('/api/store-runtime', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Access-Token': sessionStorage.getItem('auth-token') },
      body: '{}',
    });
    return { status: result.status, body: await result.json() };
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error, 'server_runtime_consent_required');
  runtimeRequests.length = 0;
  await toggleServer(page, true);
  await page.getByText(trust, { exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/accounts/add');
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(
    await page.evaluate(() => JSON.parse(localStorage.getItem('asspp-settings')).state.storeRuntimeMode),
    'server',
  );
  await page.screenshot({ path: path.join(artifacts, 'server-consent-webkit.png'), fullPage: true });
  await addInputs(page, 'synthetic@example.test');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await page.locator('#code').waitFor();
  assert.equal(await page.getByText(trust, { exact: true }).isVisible(), true);
  assert.equal(runtimeRequests.length, 1);
  assert.equal(runtimeRequests[0].headers()['x-asspp-server-consent'], 'credentials-v1');
  assert.equal(runtimeRequests[0].headers()['x-access-token'], accessToken);
  await page.locator('#code').fill('123456');
  await page.getByRole('button', { name: 'Verify', exact: true }).click();
  await page.getByText('synthetic@example.test', { exact: true }).waitFor();
  assert.equal(runtimeRequests.length, 2);
  assert.equal(runtimeRequests[1].postDataJSON().state.records.syntheticFixture, 'Zml4dHVyZQ==');
  await page.reload();
  await page.getByText('synthetic@example.test', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifacts, 'server-fixture-account-webkit.png'), fullPage: true });
  results.push(
    'one login switch with visible trust line; no Settings step or modal; actual route/helper 2FA and persisted global mode',
  );

  // A helper failure stays on the chosen transport and never invokes a worker.
  await page.getByRole('link', { name: 'Add Account', exact: true }).click();
  assert.equal(await page.getByRole('switch', { name: consent }).isChecked(), true);
  assert.equal(await page.getByText(trust, { exact: true }).isVisible(), true);
  await addInputs(page, 'failure@example.test');
  const previous = runtimeRequests.length;
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await page
    .getByText('The server could not complete the Apple account request. (HTTP 502)', { exact: true })
    .waitFor();
  assert.equal(runtimeRequests.length, previous + 1);
  results.push('server failure produces a typed transport failure without client fallback');

  await addInputs(page, 'delay@example.test');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await until(async () => {
    try {
      await readFile(path.join(fixture, 'delayed-pid'));
      return true;
    } catch {
      return false;
    }
  }, 'Delayed helper did not start');
  const pid = Number(await readFile(path.join(fixture, 'delayed-pid'), 'utf8'));
  const beforeSwitch = runtimeRequests.length;
  await toggleServer(page, false);
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return error.code === 'ESRCH';
    }
  }, 'Mode change did not kill the in-flight helper');
  assert.equal(runtimeRequests.length, beforeSwitch);
  assert.deepEqual(await page.evaluate(() => window.__runtimeProbe), { workers: 0, wasm: 0 });
  assert.deepEqual(heavyResources, []);
  assert.deepEqual(pageErrors, []);
  results.push('mode change aborts fetch and kills helper; zero worker/WASM/public-image loads');
  sample();
  measuringServerMode = false;
  await context.close();

  // Browser-origin policy tests serve only this same built app and synthetic
  // APIs through Playwright routing. HTTPS origin semantics, not Apple TLS,
  // are under test here; the loopback scenario above uses the actual backend.
  for (const { protocol, available } of [
    { protocol: 'http:', available: true },
    { protocol: 'https:', available: true },
    { protocol: 'https:', available: false },
  ]) {
    const policy = await browser.newContext({ locale: 'en-US' });
    await instrument(policy);
    let transfers = 0;
    await policy.route(`${protocol}//untrusted.example.test/**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/auth/status') return route.fulfill({ json: { required: false } });
      if (url.pathname === '/api/settings') return route.fulfill({ json: { serverStoreRuntimeAvailable: available } });
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/store-runtime') transfers++;
        return route.fulfill({ json: [] });
      }
      const response = await fetch(origin + url.pathname);
      return route.fulfill({
        status: response.status,
        headers: { 'content-type': response.headers.get('content-type') ?? 'text/html' },
        body: Buffer.from(await response.arrayBuffer()),
      });
    });
    const policyPage = await policy.newPage();
    await policyPage.goto(`${protocol}//untrusted.example.test/accounts/add`);
    const option = policyPage.getByRole('switch', { name: consent });
    await option.waitFor();
    assert.equal(await option.isChecked(), false);
    if (protocol === 'https:' && available) {
      await until(() => option.isEnabled(), 'HTTPS origin could not opt in');
      await toggleServer(policyPage, true);
      assert.equal(await option.isChecked(), true);
    } else if (protocol === 'http:') {
      assert.equal(await option.isDisabled(), true);
      await policyPage
        .getByText('Open this site through HTTPS before enabling server mode.', { exact: true })
        .waitFor();
      // A stale persisted server setting cannot bypass the actual exchange guard.
      await policyPage.evaluate(() =>
        localStorage.setItem(
          'asspp-settings',
          JSON.stringify({
            state: { storeRuntimeMode: 'server', theme: 'light', defaultCountry: 'US', defaultEntity: 'iPhone' },
            version: 0,
          }),
        ),
      );
      await policyPage.goto(`${protocol}//untrusted.example.test/accounts/add`);
      await addInputs(policyPage, 'blocked@example.test');
      await policyPage.getByRole('button', { name: 'Sign In', exact: true }).click();
      await policyPage
        .getByLabel('Notifications')
        .getByText('Open this site through HTTPS before enabling server mode.', { exact: true })
        .waitFor();
      assert.equal(transfers, 0);
      assert.deepEqual(await policyPage.evaluate(() => window.__runtimeProbe), { workers: 0, wasm: 0 });
    } else {
      assert.equal(await option.isDisabled(), true);
      assert.equal(transfers, 0);
    }
    await policy.close();
  }
  results.push(
    'remote HTTP blocks opt-in and stale settings; unavailable helper blocks opt-in; HTTPS permits explicit opt-in',
  );
  sample();
  const output = {
    browser: 'webkit',
    syntheticOnly: true,
    peakContentKiB,
    serverModePeakKiB,
    checks: results,
    screenshots: ['server-consent-webkit.png', 'server-fixture-account-webkit.png'],
  };
  await writeFile(path.join(artifacts, 'result.json'), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output));
  assert(
    serverModePeakKiB > 0 && serverModePeakKiB < 384 * 1024,
    'Server-mode account flow exceeded 384 MiB WebContent RSS',
  );
} finally {
  clearInterval(monitor);
  await defaultBrowser?.close();
  await browser.close();
  await browserServer.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(fixture, { recursive: true, force: true });
}
