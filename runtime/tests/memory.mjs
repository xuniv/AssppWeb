import assert from 'node:assert/strict';
import { fromBase64 } from '../web/sockets.mjs';
import { createFilesystem } from '../web/filesystem.mjs';

// Exercise the native bridge's decoder with an image-sized public fixture.
// The former string-iterator conversion exceeded 350 MiB for just 8 MiB.
const encoded = Buffer.alloc(8 * 1024 * 1024, 173).toString('base64');
const decoded = fromBase64(encoded);
assert.equal(decoded.length, 8 * 1024 * 1024);
assert(decoded.every((byte) => byte === 173));
assert(process.resourceUsage().maxRSS < 192 * 1024, 'Native asset decoding allocated a large intermediate array');

const fs = createFilesystem(1024);
const bytes = new Uint8Array([1, 2, 3]);
fs.add('/cache/public-test', bytes, true);
assert.equal(fs.snapshot()[0].bytes.buffer, bytes.buffer);
assert.equal(fs.allocated, 3);
assert.throws(() => fs.add('/cache/oversize', new Uint8Array(1024), true), { code: 'ENOSPC' });
fs.clear();
assert.equal(fs.allocated, 0);
console.log('Bounded native decoding and public-asset ownership passed');
