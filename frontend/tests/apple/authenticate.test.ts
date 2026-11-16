import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Authenticator, AuthenticationError } from '../../src/apple/authenticate';
import { runStore } from '../../src/apple/storeRuntime';
vi.mock('../../src/apple/storeRuntime', () => ({ runStore: vi.fn() }));
const state = { records: { 'anisette-v4': 'synthetic-state' }, cookies: [] };
const value = {
  email: 'test@example.invalid',
  passwordToken: 'synthetic-token',
  directoryServicesIdentifier: '123',
  name: 'Test User',
  storeFront: '143441-1',
  pod: '26',
};
describe('client runtime authentication', () => {
  beforeEach(() => vi.clearAllMocks());
  it('retains provisioning state for 2FA and keeps the code separate from the password', async () => {
    vi.mocked(runStore)
      .mockResolvedValueOnce({ ok: false, error: 'verification_required', value: {}, state })
      .mockResolvedValueOnce({ ok: true, value, state });
    const session = new Authenticator('020000000001');
    await expect(session.authenticate('test@example.invalid', 'synthetic-password')).rejects.toMatchObject({
      codeRequired: true,
    });
    const account = await session.authenticate('test@example.invalid', 'synthetic-password', '123456');
    expect(vi.mocked(runStore).mock.calls[1][0]).toMatchObject({
      password: 'synthetic-password',
      code: '123456',
      state,
    });
    expect(account).toMatchObject({
      store: '143441',
      pod: '26',
      runtimeState: state,
      deviceIdentifier: '020000000001',
    });
  });
  it('preserves previous routing when an auth response omits it', async () => {
    vi.mocked(runStore).mockResolvedValue({
      ok: true,
      value: { ...value, storeFront: undefined, pod: undefined },
      state,
    });
    const account = await new Authenticator('020000000001', [], { store: '143462', pod: '25' }).authenticate(
      '+821000000000',
      'synthetic-password',
    );
    expect(account.store).toBe('143462');
    expect(account.pod).toBe('25');
  });
  it('shows only a safe code/status instead of raw Apple responses', async () => {
    vi.mocked(runStore).mockResolvedValue({ ok: false, error: 'operation_failed', status: 503, value: {}, state });
    await expect(
      new Authenticator('020000000001').authenticate('test@example.invalid', 'synthetic-password'),
    ).rejects.toThrow('HTTP 503');
  });
  it('rejects a nominal success without a usable password token', async () => {
    vi.mocked(runStore).mockResolvedValue({ ok: true, value: { ...value, passwordToken: '' }, state });
    await expect(
      new Authenticator('020000000001').authenticate('test@example.invalid', 'synthetic-password'),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });
});
