import { Router, type Request } from 'express';
import fs from 'fs';
import { getBaseUrl } from './install.js';
import { buildManifest, getWhitePng } from '../services/manifestBuilder.js';
import {
  deleteUpload,
  getUpload,
  getUploadPath,
  listUploads,
  receiveUpload,
  UploadError,
  type UploadedPackage,
} from '../services/uploadManager.js';
import { getIdParam } from '../utils/route.js';

const router = Router();

function withUrls(req: Request, item: UploadedPackage) {
  const manifestUrl = `${getBaseUrl(req)}/api/install/uploads/${item.id}/manifest.plist`;
  return {
    ...item,
    manifestUrl,
    installUrl: `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`,
  };
}

router.get('/uploads', (req, res) => {
  res.json(listUploads().map((item) => withUrls(req, item)));
});

router.post('/uploads', async (req, res, next) => {
  if (!req.is('application/octet-stream')) {
    res.status(415).json({ error: 'Send the IPA as application/octet-stream' });
    return;
  }
  try {
    const item = await receiveUpload(req);
    res.status(201).json(withUrls(req, item));
  } catch (err) {
    if (err instanceof UploadError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    next(err);
  }
});

router.delete('/uploads/:id', (req, res) => {
  if (!deleteUpload(getIdParam(req))) {
    res.status(404).json({ error: 'Upload not found' });
    return;
  }
  res.sendStatus(204);
});

// Like upstream installs, UUID-bearing install links are public so iOS can
// retrieve the manifest and payload without the browser's X-Access-Token.
router.get('/install/uploads/:id/:asset', (req, res) => {
  const id = getIdParam(req);
  const item = getUpload(id);
  const filePath = getUploadPath(id);
  if (!item || !filePath || !fs.existsSync(filePath)) {
    res.status(404).json({ error: 'Upload not found' });
    return;
  }
  const asset = req.params.asset;
  const baseUrl = `${getBaseUrl(req)}/api/install/uploads/${id}`;
  if (asset === 'manifest.plist') {
    res
      .type('application/xml')
      .send(
        buildManifest(
          item.software,
          `${baseUrl}/payload.ipa`,
          `${baseUrl}/icon-small.png`,
          `${baseUrl}/icon-large.png`,
        ),
      );
    return;
  }
  if (asset === 'payload.ipa') {
    res.type('application/octet-stream').sendFile(filePath);
    return;
  }
  if (asset === 'icon-small.png' || asset === 'icon-large.png') {
    res.type('png').send(getWhitePng());
    return;
  }
  res.sendStatus(404);
});

export default router;
