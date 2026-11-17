import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ServerStoreRuntime } from '../src/services/serverStoreRuntime.js';

const directories: string[] = [];
function runtime(script: string, options: { timeoutMs?: number; maxOutputBytes?: number } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asspp-runtime-test-'));
  directories.push(directory);
  const binary = path.join(directory, 'worker');
  fs.writeFileSync(binary, `#!${process.execPath}\n${script}`, { mode: 0o700 });
  return new ServerStoreRuntime({
    enabled: true,
    binaryPath: binary,
    assetsPath: directory,
    concurrency: 1,
    timeoutMs: options.timeoutMs ?? 5000,
    maxOutputBytes: options.maxOutputBytes ?? 1024,
  });
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('private native Store processes', () => {
  it('passes one operation through private pipes without operator environment or disk state', async () => {
    const worker = runtime(`let input='';process.stdin.on('data',v=>input+=v);process.stdin.on('end',()=>{
      const request=JSON.parse(input);
      process.stderr.write('synthetic private stderr');
      process.stdout.write(JSON.stringify({ok:true,state:{records:{}},value:{
        operation:request.operation,password:request.password,operatorSecret:process.env.ASSPP_OPERATOR_TEST_SECRET??null,
        arguments:process.argv.slice(2)
      }}));
    });`);
    process.env.ASSPP_OPERATOR_TEST_SECRET = 'synthetic-operator-secret';
    try {
      const output = JSON.parse(
        (
          await worker.run(
            JSON.stringify({ operation: 'login', password: 'synthetic-password' }),
            new AbortController().signal,
          )
        ).toString(),
      );
      expect(output.value).toMatchObject({
        operation: 'login',
        password: 'synthetic-password',
        operatorSecret: null,
      });
      expect(output.value.arguments[0]).toBe('--stdio');
      expect(fs.readdirSync(directories[0])).toEqual(['worker']);
    } finally {
      delete process.env.ASSPP_OPERATOR_TEST_SECRET;
    }
  });

  it('rejects excess concurrency without queuing account requests', async () => {
    const worker = runtime(`process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>{
      process.stdout.write(JSON.stringify({ok:true,state:{}}));
    },150));`);
    const first = worker.run('{}', new AbortController().signal);
    await expect(worker.run('{}', new AbortController().signal)).rejects.toMatchObject({
      code: 'server_runtime_busy',
      status: 503,
    });
    await first;
    await expect(worker.run('{}', new AbortController().signal)).resolves.toBeInstanceOf(Buffer);
  });

  it('kills timed out and disconnected processes and releases their slots', async () => {
    const worker = runtime('process.stdin.resume();setTimeout(()=>{},10000);', { timeoutMs: 100 });
    await expect(worker.run('{}', new AbortController().signal)).rejects.toMatchObject({
      code: 'server_runtime_timeout',
      status: 504,
    });
    const controller = new AbortController();
    const pending = worker.run('{}', controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'request_canceled' });
  });

  it.each([
    ['oversized stdout', `process.stdout.write('x'.repeat(4096));`, 1024],
    ['invalid JSON', `process.stdout.write('synthetic raw failure');`, 1024],
    [
      'raw runtime errors',
      `process.stdout.write(JSON.stringify({ok:false,state:{},error:'private raw error'}));`,
      1024,
    ],
  ])('discards %s without forwarding its contents', async (_name, script, maxOutputBytes) => {
    const worker = runtime(script as string, { maxOutputBytes: maxOutputBytes as number });
    await expect(worker.run('{}', new AbortController().signal)).rejects.toMatchObject({
      code: 'server_runtime_failed',
      status: 502,
    });
  });
});
