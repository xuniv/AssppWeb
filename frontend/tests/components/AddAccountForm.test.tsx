import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AddAccountForm from '../../src/components/Account/AddAccountForm';
import { useSettingsStore } from '../../src/store/settings';
import en from '../../src/locales/en-US.json';

const mocks = vi.hoisted(() => ({ apiGet: vi.fn(), authenticate: vi.fn(), addAccount: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      let value: unknown = en;
      for (const part of key.split('.')) value = (value as Record<string, unknown>)?.[part];
      return typeof value === 'string' ? value : key;
    },
  }),
}));

vi.mock('../../src/hooks/useAccounts', () => ({
  useAccounts: () => ({ addAccount: mocks.addAccount }),
}));

vi.mock('../../src/api/client', () => ({ apiGet: mocks.apiGet }));

vi.mock('../../src/apple/authenticate', () => ({
  Authenticator: class {
    authenticate = mocks.authenticate;
  },
  AuthenticationError: class extends Error {},
}));

function showForm() {
  render(
    <MemoryRouter initialEntries={['/accounts/add']}>
      <AddAccountForm />
    </MemoryRouter>,
  );
  return screen.getByRole('switch', { name: en.settings.runtime.consent });
}

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.getState().setStoreRuntimeMode('client');
  mocks.apiGet.mockResolvedValue({ serverStoreRuntimeAvailable: true });
  vi.stubGlobal('location', { protocol: 'https:', hostname: 'asspp.example.test' });
});

afterEach(() => {
  useSettingsStore.getState().setStoreRuntimeMode('client');
  vi.unstubAllGlobals();
});

describe('login server-processing toggle', () => {
  it('defaults to device processing and enables server processing with one explicit click', async () => {
    const toggle = showForm();
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(en.settings.runtime.trust)).toBeInTheDocument();
    await waitFor(() => expect(toggle).toBeEnabled());
    fireEvent.click(toggle);
    expect(toggle).toBeChecked();
    expect(useSettingsStore.getState().storeRuntimeMode).toBe('server');
    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(useSettingsStore.getState().storeRuntimeMode).toBe('client');
  });

  it('disables enabling when the server worker is unavailable', async () => {
    mocks.apiGet.mockResolvedValue({ serverStoreRuntimeAvailable: false });
    const toggle = showForm();
    await screen.findByText(en.settings.runtime.unavailable);
    expect(toggle).toBeDisabled();
    expect(useSettingsStore.getState().storeRuntimeMode).toBe('client');
  });

  it('disables enabling over remote HTTP', async () => {
    vi.stubGlobal('location', { protocol: 'http:', hostname: '192.168.1.2' });
    const toggle = showForm();
    await screen.findByText(en.settings.runtime.httpsRequired);
    expect(toggle).toBeDisabled();
    expect(useSettingsStore.getState().storeRuntimeMode).toBe('client');
  });

  it('allows a saved server choice to be turned off even when unavailable', async () => {
    useSettingsStore.getState().setStoreRuntimeMode('server');
    mocks.apiGet.mockResolvedValue({ serverStoreRuntimeAvailable: false });
    const toggle = showForm();
    await screen.findByText(en.settings.runtime.unavailable);
    expect(toggle).toBeChecked();
    expect(toggle).toBeEnabled();
    fireEvent.click(toggle);
    expect(useSettingsStore.getState().storeRuntimeMode).toBe('client');
  });

  it('leaves the toggle usable while a login request is in flight', async () => {
    mocks.authenticate.mockReturnValue(new Promise(() => {}));
    const toggle = showForm();
    await waitFor(() => expect(toggle).toBeEnabled());
    fireEvent.click(toggle);
    fireEvent.change(screen.getByLabelText(en.accounts.addForm.email), { target: { value: 'synthetic@example.test' } });
    fireEvent.change(screen.getByLabelText(en.accounts.addForm.password), { target: { value: 'synthetic-password' } });
    fireEvent.click(screen.getByRole('button', { name: en.accounts.addForm.signIn }));
    await waitFor(() => expect(mocks.authenticate).toHaveBeenCalledTimes(1));
    expect(toggle).toBeEnabled();
    fireEvent.click(toggle);
    expect(useSettingsStore.getState().storeRuntimeMode).toBe('client');
  });
});
