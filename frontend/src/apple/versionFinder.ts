import i18n from '../i18n';
import { runStore, storeRequest } from './storeRuntime';
import type { Account, Software } from '../types';
export async function listVersions(
  account: Account,
  app: Software,
): Promise<{ versions: string[]; updatedCookies: typeof account.cookies }> {
  const result = await runStore<{ ExternalVersionIdentifiers: string[] }>(storeRequest('versions', account, app));
  if (!result.ok || !Array.isArray(result.value.ExternalVersionIdentifiers))
    throw new Error(i18n.t('errors.runtime.request'));
  return { versions: result.value.ExternalVersionIdentifiers.slice().reverse(), updatedCookies: account.cookies };
}
