import i18n from '../i18n';

import { runStore, storeRequest } from './storeRuntime';
import type { Account, Software, DownloadOutput } from '../types';
export class DownloadError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

export async function getDownloadInfo(
  account: Account,
  app: Software,
  externalVersionId?: string,
): Promise<{ output: DownloadOutput; updatedCookies: typeof account.cookies }> {
  const result = await runStore<DownloadOutput>(storeRequest('download', account, app, externalVersionId));
  if (!result.ok)
    throw new DownloadError(
      i18n.t(result.error === 'license_required' ? 'errors.download.licenseRequired' : 'errors.runtime.request') +
        (result.status ? ` (HTTP ${result.status})` : ''),
      result.error === 'license_required' ? '9610' : result.error,
    );
  const output = result.value;
  if (!output?.downloadURL || !output.sinfs?.length || !output.bundleVersion || !output.bundleShortVersionString)
    throw new DownloadError(i18n.t('errors.download.invalidSinf'));
  return { output, updatedCookies: account.cookies };
}
