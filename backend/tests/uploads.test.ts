import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createServer, request as httpRequest } from 'http';
import AdmZip from 'adm-zip';
import plist from 'plist';
import bplistCreator from 'bplist-creator';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asspp-upload-test-'));
vi.stubEnv('DATA_DIR', dataDir);
vi.stubEnv('ACCESS_PASSWORD', 'test-access-password');
vi.stubEnv('PUBLIC_BASE_URL', 'https://install.example.test');

let app: express.Express;
let manager: typeof import('../src/services/uploadManager.js');
let config: (typeof import('../src/config.js'))['config'];
let token: string;

const info = { CFBundleIdentifier: 'com.example.test', CFBundleVersion: '42', CFBundleDisplayName: 'Test & Install' };
function ipa(binary = false, metadata = info): Buffer {
  const zip = new AdmZip();
  zip.addFile('Payload/Test.app/Info.plist', binary ? bplistCreator(metadata) : Buffer.from(plist.build(metadata)));
  zip.addFile(
    'Payload/Test.app/PlugIns/Extra.appex/Info.plist',
    Buffer.from(plist.build({ CFBundleIdentifier: 'ignored' })),
  );
  return zip.toBuffer();
}
const upload = (body = ipa()) =>
  request(app)
    .post('/api/uploads')
    .set('X-Access-Token', token)
    .set('Content-Type', 'application/octet-stream')
    .send(body);

beforeAll(async () => {
  const dir = path.join(dataDir, 'uploads');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'previous.ipa'), 'old upload');
  fs.writeFileSync(path.join(dir, 'unfinished.part'), 'incomplete upload');
  manager = await import('../src/services/uploadManager.js');
  ({ config, accessPasswordHash: token } = await import('../src/config.js'));
  const { accessAuth } = await import('../src/middleware/accessAuth.js');
  const { default: routes } = await import('../src/routes/uploads.js');
  app = express();
  app.use('/api', accessAuth, routes);
});

afterEach(() => {
  config.maxDownloadMB = 0;
  config.autoCleanupDays = 0;
  config.autoCleanupMaxMB = 0;
  for (const item of manager.listUploads()) manager.deleteUpload(item.id);
});

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('temporary IPA uploads', () => {
  it('removes previous uploads and partial files at startup', () => {
    expect(fs.readdirSync(path.join(dataDir, 'uploads'))).toEqual([]);
  });

  it('requires access authentication for list, upload, and delete', async () => {
    expect((await request(app).get('/api/uploads')).status).toBe(401);
    expect((await request(app).post('/api/uploads')).status).toBe(401);
    expect((await request(app).delete('/api/uploads/anything')).status).toBe(401);
  });

  it.each([false, true])('installs an unchanged IPA with binary plist = %s', async (binary) => {
    const original = ipa(binary);
    const response = await upload(original);
    expect(response.status).toBe(201);
    const item = response.body;
    expect(item.software).toEqual({ bundleID: 'com.example.test', name: 'Test & Install', version: '42' });
    expect(item.fileSize).toBe(original.length);
    expect(item.filePath).toBeUndefined();
    expect(item.manifestUrl).toBe(`https://install.example.test/api/install/uploads/${item.id}/manifest.plist`);
    const manifest = await request(app).get(`/api/install/uploads/${item.id}/manifest.plist`);
    expect(manifest.status).toBe(200);
    expect(manifest.text).toContain('Test &amp; Install');
    expect(manifest.text).toContain('<string>42</string>');
    expect(manifest.text).toContain(`/api/install/uploads/${item.id}/payload.ipa`);
    const payload = await request(app).get(`/api/install/uploads/${item.id}/payload.ipa`);
    expect(payload.status).toBe(200);
    expect(payload.body).toEqual(original);
    expect((await request(app).get('/api/uploads').set('X-Access-Token', token)).body).toHaveLength(1);
    expect((await request(app).delete(`/api/uploads/${item.id}`).set('X-Access-Token', token)).status).toBe(204);
    expect((await request(app).get(`/api/install/uploads/${item.id}/payload.ipa`)).status).toBe(404);
  });

  it('rejects malformed archives without leaving files behind', async () => {
    expect((await upload(Buffer.from('not an IPA'))).status).toBe(400);
    expect(fs.readdirSync(path.join(dataDir, 'uploads'))).toEqual([]);
  });

  it('rejects an archive with only an extension Info.plist', async () => {
    const zip = new AdmZip();
    zip.addFile('Payload/Main.app/PlugIns/Extra.appex/Info.plist', Buffer.from(plist.build(info)));
    expect((await upload(zip.toBuffer())).status).toBe(400);
  });

  it('rejects multiple main apps and missing bundle metadata', async () => {
    const zip = new AdmZip(ipa());
    zip.addFile('Payload/Other.app/Info.plist', Buffer.from(plist.build(info)));
    expect((await upload(zip.toBuffer())).status).toBe(400);
    expect((await upload(ipa(false, { ...info, CFBundleIdentifier: '' }))).status).toBe(400);
  });

  it('bounds decompression of app metadata', async () => {
    const zip = new AdmZip();
    zip.addFile('Payload/Main.app/Info.plist', Buffer.alloc(1024 * 1024 + 1));
    expect((await upload(zip.toBuffer())).status).toBe(400);
  });

  it('enforces the upload limit and removes oversized chunked transfers', async () => {
    config.maxDownloadMB = 0.001;
    expect((await upload(Buffer.alloc(2048))).status).toBe(413);
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address() as { port: number };
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port: address.port,
            method: 'POST',
            path: '/api/uploads',
            headers: { 'X-Access-Token': token, 'Content-Type': 'application/octet-stream' },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
          },
        );
        req.on('error', reject);
        req.write(Buffer.alloc(2048));
        req.end();
      });
      expect(status).toBe(413);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(fs.readdirSync(path.join(dataDir, 'uploads'))).toEqual([]);
  });

  it('cleans old files and evicts the oldest uploads to meet the storage cap', async () => {
    const first = (await upload()).body;
    const second = (await upload()).body;
    manager.getUpload(first.id)!.createdAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
    config.autoCleanupDays = 1;
    manager.cleanupUploads();
    expect(manager.getUpload(first.id)).toBeUndefined();
    expect(manager.getUpload(second.id)).toBeDefined();
    config.autoCleanupMaxMB = 0.000001;
    manager.cleanupUploads();
    expect(manager.listUploads()).toEqual([]);
  });
});
