import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import PageContainer from '../Layout/PageContainer';
import Spinner from '../common/Spinner';
import { useAccounts } from '../../hooks/useAccounts';
import { useSettingsStore } from '../../store/settings';
import { useToastStore } from '../../store/toast';
import { Authenticator, AuthenticationError } from '../../apple/authenticate';
import { apiGet } from '../../api/client';
import { getErrorMessage } from '../../utils/error';
import { serverRuntimeTransportAllowed } from '../../utils/runtimeTransport';
import { generateDeviceId } from '../../apple/config';
import type { AuthRetry } from '../../apple/authenticate';

export default function AddAccountForm() {
  const navigate = useNavigate();
  const { addAccount } = useAccounts();
  const { t } = useTranslation();
  const addToast = useToastStore((s) => s.addToast);
  const { storeRuntimeMode, setStoreRuntimeMode } = useSettingsStore();
  const [serverRuntimeAvailable, setServerRuntimeAvailable] = useState<boolean | null>(null);
  const serverTransportAllowed = serverRuntimeTransportAllowed();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [deviceId, setDeviceId] = useState(() => generateDeviceId());
  const [needsCode, setNeedsCode] = useState(false);
  const authenticator = useRef<Authenticator | null>(null);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState<AuthRetry | null>(null);
  const inputClassName =
    'block min-h-11 w-full min-w-0 max-w-full rounded-xl border-0 bg-gray-100 px-3 py-2 text-base text-gray-900 focus:ring-2 focus:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-gray-800 dark:text-white';

  useEffect(() => {
    let active = true;
    apiGet<{ serverStoreRuntimeAvailable?: boolean }>('/api/settings')
      .then((settings) => {
        if (active) setServerRuntimeAvailable(settings.serverStoreRuntimeAvailable === true);
      })
      .catch(() => {
        if (active) setServerRuntimeAvailable(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);

    try {
      const cleanedDeviceId = deviceId.replace(/[: ]/g, '');
      setDeviceId(cleanedDeviceId);

      if (!needsCode || !authenticator.current) authenticator.current = new Authenticator(cleanedDeviceId);
      const account = await authenticator.current.authenticate(
        email,
        password,
        needsCode && code ? code : undefined,
        setRetry,
      );
      await addAccount(account);
      addToast(t('accounts.addForm.addSuccess'), 'success');
      navigate('/accounts');
    } catch (err) {
      if (err instanceof AuthenticationError && err.codeRequired) {
        setNeedsCode(true);
        addToast(err.message, 'error');
      } else {
        addToast(getErrorMessage(err, t('accounts.addForm.authFailed')), 'error');
      }
    } finally {
      setRetry(null);
      setLoading(false);
    }
  }

  return (
    <PageContainer title={t('accounts.addForm.title')}>
      <div className="max-w-2xl">
        <form onSubmit={handleSubmit} className="space-y-6">
          <section className="space-y-5 rounded-3xl bg-white p-5 shadow-sm ring-1 ring-black/5 dark:bg-gray-900 dark:ring-white/10 sm:p-6">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                {t('accounts.addForm.email')}
              </label>
              <input
                id="email"
                type="text"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={loading}
                placeholder={t('accounts.addForm.emailPlaceholder')}
                className={inputClassName}
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                {t('accounts.addForm.password')}
              </label>
              <input
                id="password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={loading}
                className={inputClassName}
              />
            </div>

            <div>
              <label htmlFor="deviceId" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                {t('accounts.addForm.deviceId')}
              </label>
              <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
                <input
                  id="deviceId"
                  type="text"
                  required
                  value={deviceId}
                  onChange={(e) => setDeviceId(e.target.value)}
                  disabled={loading || needsCode}
                  className={`${inputClassName} min-w-0 flex-1 font-mono`}
                />
                <button
                  type="button"
                  onClick={() => setDeviceId(generateDeviceId())}
                  disabled={loading || needsCode}
                  className="min-h-11 w-full shrink-0 whitespace-normal rounded-full bg-gray-100 px-4 py-2 text-sm font-semibold text-gray-600 transition-colors hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto sm:whitespace-nowrap dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
                >
                  {t('accounts.addForm.randomize')}
                </button>
              </div>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t('accounts.addForm.deviceIdHelp')}</p>
            </div>

            <div>
              <label className="flex min-h-11 items-center justify-between gap-4 text-sm font-medium text-gray-700 dark:text-gray-300">
                <span>{t('settings.runtime.consent')}</span>
                <span className="relative inline-flex shrink-0">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={storeRuntimeMode === 'server'}
                    disabled={storeRuntimeMode !== 'server' && (!serverRuntimeAvailable || !serverTransportAllowed)}
                    onChange={(event) => {
                      setStoreRuntimeMode(event.target.checked ? 'server' : 'client');
                      authenticator.current = null;
                      setNeedsCode(false);
                      setCode('');
                      setRetry(null);
                    }}
                    aria-describedby="server-runtime-trust server-runtime-availability"
                    className="peer sr-only"
                  />
                  <span
                    aria-hidden="true"
                    className="h-6 w-11 rounded-full bg-gray-300 transition-colors peer-checked:bg-blue-600 peer-focus-visible:ring-2 peer-focus-visible:ring-blue-500 peer-focus-visible:ring-offset-2 peer-disabled:opacity-50 dark:bg-gray-700"
                  />
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform peer-checked:translate-x-5"
                  />
                </span>
              </label>
              <p id="server-runtime-trust" className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {t('settings.runtime.trust')}
              </p>
              <p id="server-runtime-availability" className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {!serverTransportAllowed
                  ? t('settings.runtime.httpsRequired')
                  : serverRuntimeAvailable === false
                    ? t('settings.runtime.unavailable')
                    : null}
              </p>
            </div>

            {needsCode && (
              <div>
                <label htmlFor="code" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('accounts.addForm.code')}
                </label>
                <input
                  id="code"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  disabled={loading}
                  placeholder={t('accounts.addForm.codePlaceholder')}
                  className={inputClassName}
                  autoFocus
                />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t('accounts.addForm.codeHelp')}</p>
              </div>
            )}
          </section>

          <div className="grid grid-cols-1 gap-3 sm:flex sm:flex-wrap sm:items-center">
            <button
              type="submit"
              disabled={loading}
              className="flex min-h-11 items-center justify-center gap-2 rounded-full bg-blue-600 px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading && <Spinner />}
              {needsCode ? t('accounts.addForm.verify') : t('accounts.addForm.signIn')}
            </button>
            <button
              type="button"
              onClick={() => navigate('/accounts')}
              disabled={loading}
              className="min-h-11 rounded-full bg-gray-200 px-6 py-2.5 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-300 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
            >
              {t('accounts.addForm.cancel')}
            </button>
          </div>
          {retry && (
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {t('accounts.addForm.retrying', {
                status: retry.status,
                seconds: Math.round(retry.delayMs / 1000),
                attempt: retry.attempt,
                attempts: retry.attempts,
              })}
            </p>
          )}
        </form>
      </div>
    </PageContainer>
  );
}
