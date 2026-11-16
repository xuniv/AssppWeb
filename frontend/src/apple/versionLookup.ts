import i18n from '../i18n';
import { runStore, storeRequest } from './storeRuntime';
import type { Account, Software, VersionMetadata } from '../types';
export async function getVersionMetadata(
  account: Account,
  app: Software,
  versionId: string,
): Promise<{ metadata: VersionMetadata; updatedCookies: typeof account.cookies }> {
  const result = await runStore<{ DisplayVersion: string; ReleaseDate: string }>(
    storeRequest('versionMetadata', account, app, versionId),
  );
  if (!result.ok || !result.value.DisplayVersion || !result.value.ReleaseDate)
    throw new Error(i18n.t('errors.runtime.request'));
  return {
    metadata: { displayVersion: result.value.DisplayVersion, releaseDate: result.value.ReleaseDate },
    updatedCookies: account.cookies,
  };
}
