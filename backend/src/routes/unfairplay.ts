import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import type { TLSSocket } from 'tls';
import { config, MIN_ACCOUNT_HASH_LENGTH } from '../config.js';
import { getAllTasks } from '../services/downloadManager.js';
import { getUploadPath } from '../services/uploadManager.js';
import {
  serverUnfairplay,
  unfairplayOperations,
  UnfairplayError,
  type SourceResolver,
  type UnfairplayOperation,
  type UnfairplayRequest,
  type UnfairplayService,
} from '../services/unfairplay.js';

const sourcePath: SourceResolver = (source) => {
  let filePath: string | undefined;
  let base: string;
  if (source.kind === 'package') {
    if (!source.accountHash || source.accountHash.length < MIN_ACCOUNT_HASH_LENGTH) {
      throw new UnfairplayError('invalid_request', 400);
    }
    const task = getAllTasks().find((item) => item.id === source.id && item.status === 'completed');
    if (!task || task.accountHash !== source.accountHash) throw new UnfairplayError('source_not_found', 404);
    filePath = task.filePath;
    base = path.resolve(config.dataDir, 'packages');
  } else {
    filePath = getUploadPath(source.id);
    base = path.resolve(config.dataDir, 'uploads');
  }
  try {
    if (!filePath || !fs.lstatSync(filePath).isFile() || fs.lstatSync(filePath).isSymbolicLink()) throw new Error();
    const real = fs.realpathSync(filePath);
    if (!real.startsWith(fs.realpathSync(base) + path.sep)) throw new Error();
    return real;
  } catch {
    throw new UnfairplayError('source_not_found', 404);
  }
};

export function createUnfairplayRouter(
  service: UnfairplayService = serverUnfairplay,
  resolveSource: SourceResolver = sourcePath,
) {
  const router = Router();
  router.post('/unfairplay/:operation', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const proto = req.get('X-Forwarded-Proto')?.split(',')[0].trim().toLowerCase();
    const address = req.socket.remoteAddress ?? '';
    const loopback = address === '::1' || /^(::ffff:)?127\./.test(address);
    if (proto === 'http' || (!(req.socket as TLSSocket).encrypted && proto !== 'https' && !loopback)) {
      res.status(426).json({ error: 'unfairplay_https_required' });
      return;
    }
    if (req.get('X-Asspp-Unfairplay-Consent') !== 'model-v1' || req.get('Sec-Fetch-Site') === 'cross-site') {
      res.status(403).json({ error: 'unfairplay_consent_required' });
      return;
    }
    if (!unfairplayOperations.includes(req.params.operation as UnfairplayOperation)) {
      res.status(400).json({ error: 'unsupported_operation' });
      return;
    }
    const controller = new AbortController();
    const abort = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.once('aborted', abort);
    res.once('close', abort);
    let operation: UnfairplayRequest | undefined;
    try {
      operation = service.acquire(req.params.operation as UnfairplayOperation, controller.signal);
      await operation.receive(req, resolveSource);
      const result = await operation.run();
      if (operation.controller.signal.aborted) throw operation.controller.signal.reason;
      if (result.outputPath) {
        const suffix =
          operation.operation === 'convert_ipa_macos'
            ? 'macos'
            : operation.operation === 'strip_account_data'
              ? 'stripped'
              : 'decrypted';
        res.setHeader('X-Asspp-Unfairplay-Summary', Buffer.from(JSON.stringify(result.summary)).toString('base64url'));
        res.setHeader('Content-Disposition', `attachment; filename="App.${suffix}.ipa"`);
        res.setHeader('Content-Length', result.outputBytes!);
        res.type('application/octet-stream');
        await pipeline(fs.createReadStream(result.outputPath), res, { signal: operation.controller.signal });
      } else res.json({ ok: true, value: result.summary });
    } catch (error) {
      if (controller.signal.aborted || res.destroyed) return;
      if (res.headersSent) res.destroy();
      else {
        // Stop an incomplete upload after the fixed error response is flushed.
        if (!req.complete) res.setHeader('Connection', 'close');
        if (error instanceof UnfairplayError) res.status(error.status).json({ error: error.code });
        else res.status(500).json({ error: 'processing_failed' });
      }
    } finally {
      req.removeListener('aborted', abort);
      res.removeListener('close', abort);
      try {
        await operation?.cleanup();
      } catch {
        /* Startup cleanup retries private request removal; never log paths. */
      }
    }
  });
  return router;
}

export default createUnfairplayRouter();
