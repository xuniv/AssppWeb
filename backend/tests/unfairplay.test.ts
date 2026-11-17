import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createServer, request as httpRequest } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';

const sources = vi.hoisted(() => ({
  tasks: [] as { id: string; status: string; accountHash: string; filePath: string }[],
  uploads: new Map<string, string>(),
}));
vi.mock('../src/services/downloadManager.js', () => ({ getAllTasks: () => sources.tasks }));
vi.mock('../src/services/uploadManager.js', () => ({ getUploadPath: (id: string) => sources.uploads.get(id) }));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asspp-unfairplay-tests-'));
vi.stubEnv('DATA_DIR', path.join(root, 'data'));
vi.stubEnv('UNFAIRPLAY_TEMP_DIR', path.join(root, 'startup'));
vi.stubEnv('ACCESS_PASSWORD', 'synthetic-access-password');
let UnfairplayService: (typeof import('../src/services/unfairplay.js'))['UnfairplayService'];
let createRouter: (typeof import('../src/routes/unfairplay.js'))['createUnfairplayRouter'];
let accessAuth: (typeof import('../src/middleware/accessAuth.js'))['accessAuth'];
let token: string;
let serial = 0;

function ipa(member = 'Payload/App.app/Info.plist', bytes = Buffer.from('synthetic metadata'), mode?: number): Buffer {
  const zip = new AdmZip();
  zip.addFile(member, bytes);
  if (mode !== undefined) zip.getEntries()[0].attr = (mode << 16) >>> 0;
  return zip.toBuffer();
}
const model = Buffer.alloc(4184, 0x41);
const successScript = `const fs=require('fs');let input='';process.stdin.on('data',v=>input+=v);process.stdin.on('end',()=>{
  const value=JSON.parse(input);const files=fs.readdirSync(process.cwd());
  const privateFiles=files.every(name=>name==='input.ipa')&&files.every(name=>(fs.statSync(name).mode&0o777)===0o600);
  const ready=privateFiles&&((fs.statSync(process.cwd()).mode&0o777)===0o700)&&value.models.every(v=>Buffer.from(v,'base64').length===4184)&&process.env.UNFAIRPLAY_OPERATOR_SECRET===undefined;
  if(value.outputPath)fs.writeFileSync(value.outputPath,'synthetic-private-result',{flag:'wx',mode:0o600});
  process.stderr.write('synthetic-model-id raw private diagnostic');
  process.stdout.write(JSON.stringify({ok:true,value:{ready,modelCount:value.models.length,modelVersions:[2],plaintextVerified:false,encryptedImages:2,decryptedPages:3,accountDataStripped:value.stripAccountData,outputPath:value.outputPath,outputSHA256:'a'.repeat(64),modelID:'synthetic-model-id',selector:'synthetic-account-selector'}}));
});`;

function fixture(script = successScript, overrides: Record<string, number> = {}) {
  const base = path.join(root, `case-${++serial}`);
  fs.mkdirSync(base);
  const binary = path.join(base, 'worker');
  fs.writeFileSync(binary, `#!${process.execPath}\n${script}`, { mode: 0o700 });
  const tempDir = path.join(base, 'requests');
  const service = new UnfairplayService({
    enabled: true,
    binaryPath: binary,
    tempDir,
    maxIpaBytes: 1024 * 1024,
    maxOutputBytes: 1024 * 1024,
    maxModels: 2,
    concurrency: 1,
    timeoutMs: 3000,
    maxEntryBytes: 512 * 1024,
    maxExpandedBytes: 1024 * 1024,
    minimumFreeBytes: 0,
    ...overrides,
  });
  const app = express();
  app.use('/api', accessAuth, createRouter(service));
  return { app, service, tempDir };
}

function operation(app: express.Express, name = 'decrypt') {
  return request(app)
    .post(`/api/unfairplay/${name}`)
    .set('X-Access-Token', token)
    .set('X-Asspp-Unfairplay-Consent', 'model-v1');
}

async function empty(tempDir: string) {
  await vi.waitFor(() => expect(fs.readdirSync(tempDir)).toEqual([]));
}

beforeAll(async () => {
  ({ UnfairplayService } = await import('../src/services/unfairplay.js'));
  ({ createUnfairplayRouter: createRouter } = await import('../src/routes/unfairplay.js'));
  ({ accessAuth } = await import('../src/middleware/accessAuth.js'));
  ({ accessPasswordHash: token } = await import('../src/config.js'));
});
beforeEach(() => {
  sources.tasks = [];
  sources.uploads.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('private transient UnfairPlay requests', () => {
  it('requires access authentication and independent model consent before receiving bodies', async () => {
    const { app, tempDir } = fixture();
    expect((await request(app).post('/api/unfairplay/decrypt')).status).toBe(401);
    expect((await request(app).post('/api/unfairplay/decrypt').set('X-Access-Token', token)).status).toBe(403);
    expect((await operation(app, 'setup')).status).toBe(400);
    await empty(tempDir);
  });

  it.each([
    [{ 'X-Forwarded-Proto': 'http' }, 426],
    [{ 'Sec-Fetch-Site': 'cross-site' }, 403],
  ])('rejects unsuitable private transport headers', async (headers, status) => {
    const { app, tempDir } = fixture();
    expect((await operation(app).set(headers as Record<string, string>)).status).toBe(status);
    await empty(tempDir);
  });

  it('streams a private result with memory-only models and sanitized summary, then deletes files', async () => {
    const { app, tempDir } = fixture();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.UNFAIRPLAY_OPERATOR_SECRET = 'synthetic-operator-secret';
    let response;
    try {
      response = await operation(app)
        .field('stripAccountData', 'true')
        .attach('models', model, 'private-name.bin')
        .attach('ipa', ipa(), 'private-app.ipa');
    } finally {
      delete process.env.UNFAIRPLAY_OPERATOR_SECRET;
    }
    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe('synthetic-private-result');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-disposition']).toBe('attachment; filename="App.decrypted.ipa"');
    const summary = JSON.parse(Buffer.from(response.headers['x-asspp-unfairplay-summary'], 'base64url').toString());
    expect(summary).toMatchObject({ ready: true, modelCount: 1, plaintextVerified: false, accountDataStripped: true });
    expect(summary).not.toHaveProperty('modelID');
    expect(summary).not.toHaveProperty('selector');
    expect(summary).not.toHaveProperty('outputPath');
    expect(summary).not.toHaveProperty('outputSHA256');
    expect(log).not.toHaveBeenCalled();
    await empty(tempDir);
  });

  it('defaults plain decryption to retaining account data and accepts multiple models', async () => {
    const { app, tempDir } = fixture();
    const response = await operation(app)
      .attach('ipa', ipa(), 'input.ipa')
      .attach('models', model, 'one.bin')
      .attach('models', model, 'two.bin');
    expect(response.status).toBe(200);
    const summary = JSON.parse(Buffer.from(response.headers['x-asspp-unfairplay-summary'], 'base64url').toString());
    expect(summary).toMatchObject({ modelCount: 2, accountDataStripped: false });
    await empty(tempDir);
  });

  it('returns model inspection and verification summaries without paths or retained plaintext', async () => {
    const { app, tempDir } = fixture();
    const inspect = await operation(app, 'model_inspect').attach('models', model, 'one.bin');
    expect(inspect.status).toBe(200);
    expect(inspect.body.value).toMatchObject({ ready: true, modelCount: 1 });
    expect(inspect.body.value).not.toHaveProperty('modelID');
    await empty(tempDir);
    const verify = await operation(app, 'verify').attach('models', model, 'one.bin').attach('ipa', ipa(), 'input.ipa');
    expect(verify.status).toBe(200);
    expect(verify.body).toMatchObject({ ok: true, value: { plaintextVerified: false } });
    await empty(tempDir);
  });

  it('streams standalone account stripping without transferring models', async () => {
    const { app, tempDir } = fixture();
    const response = await operation(app, 'strip_account_data').attach('ipa', ipa(), 'input.ipa');
    expect(response.status).toBe(200);
    expect(response.headers['content-disposition']).toContain('App.stripped.ipa');
    await empty(tempDir);
    expect(
      (
        await operation(app, 'strip_account_data')
          .attach('models', model, 'unneeded.bin')
          .attach('ipa', ipa(), 'input.ipa')
      ).status,
    ).toBe(400);
    await empty(tempDir);
  });

  it('rejects malformed multipart, unknown fields, wrong model sizes and oversized IPAs with cleanup', async () => {
    const { app, tempDir } = fixture(successScript, { maxIpaBytes: 512 });
    const malformed = await operation(app)
      .set('Content-Type', 'multipart/form-data; boundary=broken')
      .send('--broken\r\n');
    expect(malformed.status).toBe(400);
    await empty(tempDir);
    expect((await operation(app, 'model_inspect').attach('models', Buffer.alloc(12), 'bad.bin')).status).toBe(400);
    await empty(tempDir);
    expect((await operation(app).field('account', 'synthetic-credentials')).status).toBe(400);
    await empty(tempDir);
    expect((await operation(app).attach('ipa', Buffer.alloc(513), 'oversized.ipa')).status).toBe(413);
    await empty(tempDir);
  });

  it('rejects ZIP expansion, symlinks, aliases and unsafe archive names before starting native work', async () => {
    const { app, tempDir } = fixture('process.stdout.write("native should not run");', { maxExpandedBytes: 128 });
    for (const archive of [
      ipa('large.bin', Buffer.alloc(256)),
      ipa('Payload/App.app/link', Buffer.from('target'), 0o120777),
    ]) {
      const response = await operation(app, 'doctor').attach('ipa', archive, 'input.ipa');
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'invalid_input' });
      await empty(tempDir);
    }
    const aliases = new AdmZip();
    aliases.addFile('Payload/A', Buffer.alloc(1));
    aliases.addFile('payload/a', Buffer.alloc(1));
    expect((await operation(app, 'doctor').attach('ipa', aliases.toBuffer(), 'input.ipa')).status).toBe(400);
    await empty(tempDir);
  });

  it('uses existing package/upload files read-only without browser IPA transfer or modifying originals', async () => {
    const { app, tempDir } = fixture();
    const packages = path.join(root, 'data', 'packages');
    const uploads = path.join(root, 'data', 'uploads');
    fs.mkdirSync(packages, { recursive: true });
    fs.mkdirSync(uploads, { recursive: true });
    const original = ipa();
    const packageFile = path.join(packages, 'original.ipa');
    const uploadFile = path.join(uploads, 'original.ipa');
    fs.writeFileSync(packageFile, original);
    fs.writeFileSync(uploadFile, original);
    sources.tasks.push({
      id: 'package-one',
      status: 'completed',
      accountHash: 'synthetic-public-hash',
      filePath: packageFile,
    });
    sources.uploads.set('upload-one', uploadFile);
    for (const source of [
      { kind: 'package', id: 'package-one', accountHash: 'synthetic-public-hash' },
      { kind: 'upload', id: 'upload-one' },
    ]) {
      const response = await operation(app).field('source', JSON.stringify(source)).attach('models', model, 'one.bin');
      expect(response.status).toBe(200);
      expect(fs.readFileSync(packageFile)).toEqual(original);
      expect(fs.readFileSync(uploadFile)).toEqual(original);
      await empty(tempDir);
    }
    const denied = await operation(app)
      .field('source', JSON.stringify({ kind: 'package', id: 'package-one', accountHash: 'wrong-public-hash' }))
      .attach('models', model, 'one.bin');
    expect(denied.status).toBe(404);
    await empty(tempDir);
    sources.tasks[0].filePath = path.join(root, 'outside.ipa');
    fs.writeFileSync(sources.tasks[0].filePath, original);
    expect(
      (
        await operation(app)
          .field('source', JSON.stringify({ kind: 'package', id: 'package-one', accountHash: 'synthetic-public-hash' }))
          .attach('models', model, 'one.bin')
      ).status,
    ).toBe(404);
    await empty(tempDir);
  });

  it('disallows mixing an existing source with a new IPA or passing arbitrary paths', async () => {
    const { app, tempDir } = fixture();
    expect(
      (
        await operation(app, 'doctor')
          .field('source', JSON.stringify({ kind: 'upload', id: 'one', path: '/private' }))
          .attach('ipa', ipa(), 'input.ipa')
      ).status,
    ).toBe(400);
    await empty(tempDir);
    expect(
      (
        await operation(app, 'doctor')
          .field('source', JSON.stringify({ kind: 'upload', id: 'one' }))
          .attach('ipa', ipa(), 'input.ipa')
      ).status,
    ).toBe(400);
    await empty(tempDir);
  });

  it('rejects concurrency without queuing request models and releases slots after cleanup', async () => {
    const { app, service, tempDir } = fixture();
    const held = service.acquire('model_inspect', new AbortController().signal);
    expect((await operation(app, 'model_inspect').attach('models', model, 'one.bin')).status).toBe(503);
    await held.cleanup();
    expect((await operation(app, 'model_inspect').attach('models', model, 'one.bin')).status).toBe(200);
    await empty(tempDir);
  });

  it('kills timed-out helpers, bounds stdout, sanitizes private failures and cleans every request', async () => {
    const slow = fixture('process.stdin.resume();setTimeout(()=>{},10000);', { timeoutMs: 100 });
    expect((await operation(slow.app, 'model_inspect').attach('models', model, 'one.bin')).status).toBe(504);
    await empty(slow.tempDir);
    for (const script of [
      'process.stdout.write("private raw model failure");',
      'process.stdout.write("x".repeat(70000));',
      'process.stdout.write(JSON.stringify({ok:false,error:"private raw model failure"}));',
      'process.stdout.write(JSON.stringify({ok:false,error:"__proto__"}));',
    ]) {
      const { app, tempDir } = fixture(script);
      const response = await operation(app, 'model_inspect').attach('models', model, 'one.bin');
      expect(response.status).toBe(502);
      expect(response.body).toEqual({ error: 'processing_failed' });
      await empty(tempDir);
    }
  });

  it('preserves only fixed native input/model/output-limit failures', async () => {
    for (const [code, status] of [
      ['invalid_model', 400],
      ['invalid_input', 400],
      ['output_limit', 413],
    ] as const) {
      const { app, tempDir } = fixture(
        `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({ok:false,error:'${code}'})));`,
      );
      const response = await operation(app, 'model_inspect').attach('models', model, 'one.bin');
      expect(response.status).toBe(status);
      expect(response.body).toEqual({ error: code });
      await empty(tempDir);
    }
  });

  it('cleans partial uploads on disconnect and removes stale private directories at startup', async () => {
    const { app, service, tempDir } = fixture();
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address() as { port: number };
      const req = httpRequest({
        host: '127.0.0.1',
        port: address.port,
        method: 'POST',
        path: '/api/unfairplay/doctor',
        headers: {
          'X-Access-Token': token,
          'X-Asspp-Unfairplay-Consent': 'model-v1',
          'Content-Type': 'multipart/form-data; boundary=partial',
        },
      });
      req.on('error', () => {});
      req.write(
        '--partial\r\nContent-Disposition: form-data; name="ipa"; filename="input.ipa"\r\nContent-Type: application/octet-stream\r\n\r\nprivate-partial',
      );
      await vi.waitFor(() => expect(fs.readdirSync(tempDir)).toHaveLength(1));
      req.destroy();
      await empty(tempDir);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const stale = path.join(tempDir, 'request-Ab12Cd');
    fs.mkdirSync(stale, { mode: 0o700 });
    fs.writeFileSync(path.join(stale, 'input.ipa'), 'stale private data', { mode: 0o600 });
    const restarted = new UnfairplayService(service.options);
    expect(restarted.available()).toBe(true);
    await empty(tempDir);
  });

  it('kills an in-flight private helper when its requester disconnects', async () => {
    const { app, tempDir } = fixture(
      `const fs=require('fs');process.stdin.resume();process.stdin.on('end',()=>{fs.writeFileSync('pid',String(process.pid),{mode:0o600});setTimeout(()=>{},10000);});`,
    );
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address() as { port: number };
      const req = httpRequest({
        host: '127.0.0.1',
        port: address.port,
        method: 'POST',
        path: '/api/unfairplay/model_inspect',
        headers: {
          'X-Access-Token': token,
          'X-Asspp-Unfairplay-Consent': 'model-v1',
          'Content-Type': 'multipart/form-data; boundary=request',
        },
      });
      req.on('error', () => {});
      req.end(
        Buffer.concat([
          Buffer.from(
            '--request\r\nContent-Disposition: form-data; name="models"; filename="model.bin"\r\nContent-Type: application/octet-stream\r\n\r\n',
          ),
          model,
          Buffer.from('\r\n--request--\r\n'),
        ]),
      );
      let pid = 0;
      await vi.waitFor(() => {
        const directory = fs.readdirSync(tempDir)[0];
        expect(directory).toBeDefined();
        pid = Number(fs.readFileSync(path.join(tempDir, directory, 'pid')));
      });
      req.destroy();
      await empty(tempDir);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
