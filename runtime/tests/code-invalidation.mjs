import assert from 'node:assert/strict';
import { initializeUnicorn } from '../web/unicorn.mjs';
await initializeUnicorn();
const a = assppUnicorn.create(),
  b = assppUnicorn.create();
const instruction = (value) => new Uint8Array(new Uint32Array([0xd2800000 | (value << 5), 0xd61f0280]).buffer);
for (const e of [a, b]) {
  e.map('4096', '4096');
  e.map('12288', '4096');
  e.write('4096', instruction(11));
  e.seal();
  e.regWrite(219, '12288');
}
a.write('4096', instruction(73));
function run(e) {
  let pc = '4096';
  for (let i = 0; i < 10 && pc !== '12288'; i++) {
    const r = e.start(pc, '12288', '100');
    assert.equal(r.error, '');
    pc = e.regRead(260);
  }
  assert.equal(pc, '12288');
  return e.regRead(199);
}
assert.equal(run(a), '73');
assert.equal(run(b), '11');
b.write('4096', instruction(74));
assert.equal(run(b), '74');
assert.equal(run(a), '73');
a.close();
b.close();
assert.equal(assppUnicorn.memoryStatistics().backingBytes, 65536);
console.log('Shared code isolation and post-execution code invalidation passed');
