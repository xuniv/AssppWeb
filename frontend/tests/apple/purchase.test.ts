import { beforeEach, describe, expect, it, vi } from 'vitest';
import { purchaseApp } from '../../src/apple/purchase';
import { runStore } from '../../src/apple/storeRuntime';
import type { Account, Software } from '../../src/types';
vi.mock('../../src/apple/storeRuntime', async (original) => ({
  ...(await original<typeof import('../../src/apple/storeRuntime')>()),
  runStore: vi.fn(),
}));
const account = { email: 'test@example.invalid', cookies: [], deviceIdentifier: '020000000001' } as unknown as Account;
const app = { id: 123, price: 0 } as Software;
const state = { records: {}, cookies: [] };
describe('modern Store free licensing', () => {
  beforeEach(() => vi.clearAllMocks());
  it('rejects paid acquisitions before invoking the runtime', async () => {
    await expect(purchaseApp(account, { ...app, price: 1 })).rejects.toThrow();
    expect(runStore).not.toHaveBeenCalled();
  });
  it('treats an existing license as success', async () => {
    vi.mocked(runStore).mockResolvedValue({ ok: false, error: 'license_exists', value: null, state });
    expect((await purchaseApp(account, app)).alreadyOwned).toBe(true);
  });
  it('preserves explicit authentication failures', async () => {
    vi.mocked(runStore).mockResolvedValue({ ok: false, error: 'token_expired', value: null, state });
    await expect(purchaseApp(account, app)).rejects.toMatchObject({ code: 'token_expired' });
  });
});
