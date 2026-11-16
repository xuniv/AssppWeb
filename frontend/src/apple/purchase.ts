import i18n from '../i18n';
import { runStore, storeRequest } from './storeRuntime';
import type { Account, Software } from '../types';
export class PurchaseError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'PurchaseError';
  }
}
export interface PurchaseResult {
  updatedCookies: Account['cookies'];
  alreadyOwned: boolean;
}
export async function purchaseApp(account: Account, app: Software): Promise<PurchaseResult> {
  if ((app.price ?? 0) > 0) throw new PurchaseError(i18n.t('errors.purchase.paidNotSupported'));
  const result = await runStore<unknown>(storeRequest('purchase', account, app));
  if (!result.ok && result.error !== 'license_exists')
    throw new PurchaseError(
      i18n.t('errors.runtime.request') + (result.status ? ` (HTTP ${result.status})` : ''),
      result.error,
    );
  return { updatedCookies: account.cookies, alreadyOwned: result.error === 'license_exists' };
}
