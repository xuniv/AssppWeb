import { Blob, File } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importUnfairPlayModels, listUnfairPlayModels, removeUnfairPlayModel } from '../../src/store/unfairplayModels';

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('Blob', Blob);
});
afterEach(async () => {
  for (const model of await listUnfairPlayModels()) await removeUnfairPlayModel(model.id);
  vi.unstubAllGlobals();
});
describe('private binary enrollment models', () => {
  it('stores Blob bytes in a separate IndexedDB database, deduplicates content and deletes it', async () => {
    const bytes = new Uint8Array(4184).fill(7);
    const file = new File([bytes], 'multi.bin') as unknown as globalThis.File;
    const imported = await importUnfairPlayModels([file]);
    await importUnfairPlayModels([file]);
    const saved = await listUnfairPlayModels();
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe(imported[0].id);
    expect(new Uint8Array(await saved[0].data.arrayBuffer())).toEqual(bytes);
    expect(localStorage.getItem('asspp-unfairplay-private-models')).toBeNull();
    await removeUnfairPlayModel(saved[0].id);
    expect(await listUnfairPlayModels()).toEqual([]);
  });
  it('rejects oversized, unsupported-size and excessive imports without persisting a partial set', async () => {
    const supported = new File([new Uint8Array(4176)], 'one.bin') as unknown as globalThis.File;
    const invalid = new File([new Uint8Array(9000)], 'invalid.bin') as unknown as globalThis.File;
    await expect(importUnfairPlayModels([supported, invalid])).rejects.toThrow('invalid_model_size');
    await expect(importUnfairPlayModels(Array(257).fill(supported))).rejects.toThrow('invalid_model_size');
    expect(await listUnfairPlayModels()).toEqual([]);
  });
});
