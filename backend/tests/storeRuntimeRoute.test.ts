import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import storeRuntimeRoutes from '../src/routes/storeRuntime.js';
import { serverStoreRuntime } from '../src/services/serverStoreRuntime.js';

const valid = { operation: 'login', deviceID: '020000000001', email: 'synthetic@example.test', password: 'synthetic' };
function app() {
  const value = express();
  // Same ordering as production: access authentication precedes private parsing.
  value.use('/api', (req, res, next) => {
    if (req.get('X-Access-Token') !== 'test-token') return res.sendStatus(401);
    next();
  });
  value.use('/api', storeRuntimeRoutes);
  return value;
}

describe('optional server Store route', () => {
  beforeEach(() => {
    vi.spyOn(serverStoreRuntime, 'available').mockReturnValue(true);
    vi.spyOn(serverStoreRuntime, 'run').mockResolvedValue(
      Buffer.from('{"ok":false,"error":"verification_required","state":{"records":{}}}'),
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it('requires access authentication and explicit credential consent before reading private requests', async () => {
    expect((await request(app()).post('/api/store-runtime').send(valid)).status).toBe(401);
    expect(
      (await request(app()).post('/api/store-runtime').set('X-Access-Token', 'test-token').send(valid)).status,
    ).toBe(403);
    expect(serverStoreRuntime.run).not.toHaveBeenCalled();
  });

  it('preserves typed 2FA state and disables response caching', async () => {
    const response = await request(app())
      .post('/api/store-runtime')
      .set('X-Access-Token', 'test-token')
      .set('X-Asspp-Server-Consent', 'credentials-v1')
      .send(valid);
    expect(response.status).toBe(200);
    expect(response.body.error).toBe('verification_required');
    expect(response.body.state.records).toEqual({});
    expect(response.headers['cache-control']).toBe('no-store');
    expect(serverStoreRuntime.run).toHaveBeenCalledWith(JSON.stringify(valid), expect.any(AbortSignal));
  });

  it.each([
    ['cross-site', { 'Sec-Fetch-Site': 'cross-site' }, 403],
    ['proxy HTTP', { 'X-Forwarded-Proto': 'http' }, 426],
  ])('rejects %s before spawning the helper', async (_name, headers, status) => {
    const response = await request(app())
      .post('/api/store-runtime')
      .set('X-Access-Token', 'test-token')
      .set('X-Asspp-Server-Consent', 'credentials-v1')
      .set(headers as Record<string, string>)
      .send(valid);
    expect(response.status).toBe(status);
    expect(serverStoreRuntime.run).not.toHaveBeenCalled();
  });

  it('bounds private input and returns fixed parse failures without echoing it', async () => {
    for (const [body, status] of [
      ['{"password":"synthetic-private-data",', 400],
      [JSON.stringify({ ...valid, password: 'x'.repeat(8 * 1024 * 1024) }), 413],
    ] as const) {
      const response = await request(app())
        .post('/api/store-runtime')
        .set('X-Access-Token', 'test-token')
        .set('X-Asspp-Server-Consent', 'credentials-v1')
        .set('Content-Type', 'application/json')
        .send(body);
      expect(response.status).toBe(status);
      expect(response.body).toEqual({ error: 'invalid_runtime_request' });
    }
    expect(serverStoreRuntime.run).not.toHaveBeenCalled();
  });

  it('excludes native preflights and arbitrary request fields from the public API', async () => {
    const response = await request(app())
      .post('/api/store-runtime')
      .set('X-Access-Token', 'test-token')
      .set('X-Asspp-Server-Consent', 'credentials-v1')
      .send({ ...valid, operation: 'network-preflight', endpoint: 'https://other.test/' });
    expect(response.status).toBe(400);
    expect(serverStoreRuntime.run).not.toHaveBeenCalled();
  });
});
