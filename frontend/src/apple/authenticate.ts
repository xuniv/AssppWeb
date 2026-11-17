import i18n from '../i18n';
import { runStore } from './storeRuntime';
import type { RuntimeAccount, RuntimeState } from './storeRuntime';
import type { Account, Cookie } from '../types';

export class AuthenticationError extends Error {
  constructor(
    message: string,
    public readonly codeRequired = false,
  ) {
    super(message);
    this.name = 'AuthenticationError';
  }
}
export interface AuthRetry {
  status: number;
  attempt: number;
  attempts: number;
  delayMs: number;
}

/** Provisioning/2FA state is saved on this client between code attempts. */
export class Authenticator {
  private state?: RuntimeState;
  private busy = false;
  constructor(
    private readonly deviceId: string,
    private readonly existingCookies: Cookie[] = [],
    private readonly previous?: Pick<Account, 'store' | 'pod' | 'runtimeState'>,
  ) {
    this.state = previous?.runtimeState;
  }

  async authenticate(
    email: string,
    password: string,
    code?: string,
    _onRetry?: (retry: AuthRetry) => void,
  ): Promise<Account> {
    if (this.busy) throw new Error(i18n.t('errors.runtime.busy'));
    this.busy = true;
    try {
      const result = await runStore<RuntimeAccount>({
        operation: 'login',
        deviceID: this.deviceId,
        email,
        password,
        code,
        state: this.state,
      });
      if (result.state?.records) this.state = result.state;
      if (!result.ok)
        throw new AuthenticationError(
          i18n.t('errors.runtime.request') +
            (result.status ? ` (HTTP ${result.status})` : ` (${result.error ?? 'operation_failed'})`),
          result.error === 'verification_required',
        );
      const value = result.value;
      const store = value.storeFront?.split('-')[0] || this.previous?.store || '';
      if (!value.passwordToken || !value.directoryServicesIdentifier || !store)
        throw new AuthenticationError(i18n.t('errors.auth.invalidResponse'));
      const [firstName = '', ...last] = (value.name ?? '').split(' ');
      return {
        email,
        password,
        appleId: value.email ?? email,
        store,
        firstName,
        lastName: last.join(' '),
        passwordToken: value.passwordToken,
        directoryServicesIdentifier: value.directoryServicesIdentifier,
        cookies: this.existingCookies,
        deviceIdentifier: this.deviceId,
        pod: value.pod ?? this.previous?.pod,
        runtimeState: this.state,
      };
    } finally {
      this.busy = false;
    }
  }
}
export async function authenticate(
  email: string,
  password: string,
  code?: string,
  existingCookies?: Cookie[],
  deviceId = '',
  onRetry?: (retry: AuthRetry) => void,
  previous?: Pick<Account, 'store' | 'pod' | 'runtimeState'>,
): Promise<Account> {
  return new Authenticator(deviceId, existingCookies, previous).authenticate(email, password, code, onRetry);
}
