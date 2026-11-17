import express, { Router, type RequestHandler } from 'express';
import type { TLSSocket } from 'tls';
import { SERVER_RUNTIME_MAX_BYTES } from '../config.js';
import { ServerRuntimeError, serverStoreRuntime } from '../services/serverStoreRuntime.js';

const router = Router();
const operations = new Set(['login', 'purchase', 'download', 'versions', 'versionMetadata']);
const fields = new Set([
  'operation',
  'deviceID',
  'email',
  'password',
  'code',
  'state',
  'account',
  'app',
  'versionID',
  'platform',
]);
const parse = express.json({ limit: SERVER_RUNTIME_MAX_BYTES });
const parsePrivateBody: RequestHandler = (req, res, next) => {
  parse(req, res, (error?: { type?: string }) => {
    if (error) {
      res.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: 'invalid_runtime_request' });
      return;
    }
    next();
  });
};

router.post(
  '/store-runtime',
  (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    const forwardedProto = req.get('X-Forwarded-Proto')?.split(',')[0].trim().toLowerCase();
    const address = req.socket.remoteAddress ?? '';
    const loopback = address === '::1' || /^(::ffff:)?127\./.test(address);
    if (
      forwardedProto === 'http' ||
      (!(req.socket as TLSSocket).encrypted && forwardedProto !== 'https' && !loopback)
    ) {
      res.status(426).json({ error: 'server_runtime_https_required' });
      return;
    }
    if (req.get('X-Asspp-Server-Consent') !== 'credentials-v1' || req.get('Sec-Fetch-Site') === 'cross-site') {
      res.status(403).json({ error: 'server_runtime_consent_required' });
      return;
    }
    if (!serverStoreRuntime.available()) {
      res.status(503).json({ error: 'server_runtime_unavailable' });
      return;
    }
    next();
  },
  parsePrivateBody,
  async (req, res) => {
    const body = req.body;
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => !fields.has(key)) ||
      !operations.has(body.operation) ||
      typeof body.deviceID !== 'string' ||
      !/^[0-9a-f]{12}$/i.test(body.deviceID)
    ) {
      res.status(400).json({ error: 'invalid_runtime_request' });
      return;
    }
    const controller = new AbortController();
    const abort = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.once('aborted', abort);
    res.once('close', abort);
    try {
      const output = await serverStoreRuntime.run(JSON.stringify(body), controller.signal);
      if (!controller.signal.aborted) res.type('application/json').send(output);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ServerRuntimeError) res.status(error.status).json({ error: error.code });
      else res.status(502).json({ error: 'server_runtime_failed' });
    } finally {
      req.removeListener('aborted', abort);
      res.removeListener('close', abort);
    }
  },
);

export default router;
