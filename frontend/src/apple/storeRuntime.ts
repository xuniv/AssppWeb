import { getAccessToken } from '../components/Auth/PasswordGate';
import { useAccountsStore } from '../store/accounts';
import { useRuntimeStore } from '../store/runtime';
import { useSettingsStore, type StoreRuntimeMode } from '../store/settings';
import { authHeaders } from '../api/client';
import { serverRuntimeTransportAllowed } from '../utils/runtimeTransport';
import i18n from '../i18n';
import type { Account, Software } from '../types';

export interface RuntimeState {
  records: Record<string, string>;
  cookies: { URL: string; Cookie: Record<string, unknown> }[] | null;
}
export interface RuntimeAccount {
  email?: string;
  passwordToken?: string;
  directoryServicesIdentifier?: string;
  name?: string;
  storeFront?: string;
  pod?: string;
}
export interface RuntimeResponse<T> {
  ok: boolean;
  value: T;
  state: RuntimeState;
  error?: string;
  status?: number;
}
interface Request {
  operation: string;
  deviceID: string;
  email?: string;
  password?: string;
  code?: string;
  state?: RuntimeState;
  account?: RuntimeAccount & { password?: string };
  app?: Record<string, unknown>;
  versionID?: string;
}
let worker: Worker | undefined;
let next = 1;
let queue = Promise.resolve();
const jobs = new Map<
  number,
  { resolve: (value: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
>();
const states = new Map<string, RuntimeState>();
const epochs = new Map<string, number>();
const serverRequests = new Set<AbortController>();
let transportEpoch = 0;

function stop() {
  worker?.terminate();
  worker = undefined;
  for (const job of jobs.values()) {
    clearTimeout(job.timer);
    job.reject(new Error('Store runtime stopped'));
  }
  jobs.clear();
  for (const controller of serverRequests) controller.abort();
  serverRequests.clear();
  useRuntimeStore.getState().setStage('');
}
function getWorker(): Worker {
  if (worker) return worker;
  const value = new Worker('/store-runtime/store-runtime.js?memory=stream-v1');
  worker = value;
  value.onerror = stop;
  value.onmessage = async ({ data }) => {
    if (data.type === 'fatal') {
      stop();
      return;
    }
    if (data.type === 'progress') {
      useRuntimeStore.getState().setStage(data.stage);
      return;
    }
    if (data.type === 'host') {
      // A prior cached worker can still finish during an upgrade. Public
      // images now stream directly from HTTP; never clone them into this page.
      value.postMessage({ type: 'reply', id: data.id, value: null });
      return;
    }
    if (data.type === 'result') {
      const job = jobs.get(data.id);
      if (!job) return;
      clearTimeout(job.timer);
      jobs.delete(data.id);
      if (data.error) job.reject(new Error('Store runtime could not complete the request'));
      else job.resolve(data.value);
    }
  };
  const url = new URL('/wisp/', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = getAccessToken();
  if (token) url.searchParams.set('token', token);
  value.postMessage({ type: 'initialize', wispURL: url.href });
  return value;
}
async function exchange(input: string, mode: StoreRuntimeMode, epoch: number): Promise<string> {
  // Consent is rechecked immediately before transfer, including queued work.
  // A mode change never moves an in-flight login or retry to another machine.
  if (useSettingsStore.getState().storeRuntimeMode !== mode || epoch !== transportEpoch) {
    throw new Error(i18n.t('settings.runtime.modeChanged'));
  }
  if (mode === 'server') {
    if (!serverRuntimeTransportAllowed()) throw new Error(i18n.t('settings.runtime.httpsRequired'));
    const controller = new AbortController();
    serverRequests.add(controller);
    useRuntimeStore.getState().setStage('running');
    const timer = setTimeout(() => controller.abort(), 5 * 60 * 1000 + 5000);
    try {
      const result = await fetch('/api/store-runtime', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Asspp-Server-Consent': 'credentials-v1',
          ...authHeaders(),
        },
        body: input,
        signal: controller.signal,
        cache: 'no-store',
        redirect: 'error',
      });
      if (!result.ok) {
        throw new Error(`${i18n.t('settings.runtime.serverFailed')} (HTTP ${result.status})`);
      }
      return await result.text();
    } finally {
      clearTimeout(timer);
      serverRequests.delete(controller);
      useRuntimeStore.getState().setStage('');
    }
  }
  return new Promise((resolve, reject) => {
    const id = next++;
    const target = getWorker();
    const timer = setTimeout(stop, 15 * 60 * 1000);
    jobs.set(id, { resolve, reject, timer });
    target.postMessage({ type: 'run', id, input });
  });
}

useSettingsStore.subscribe((current, previous) => {
  if (current.storeRuntimeMode !== previous.storeRuntimeMode) {
    transportEpoch++;
    stop();
  }
});
export function forgetRuntimeAccount(email: string) {
  epochs.set(email, (epochs.get(email) ?? 0) + 1);
  for (const key of states.keys()) if (key.startsWith(`${email}\0`)) states.delete(key);
}
export function currentRuntimeState(email: string, deviceID: string): RuntimeState | undefined {
  return states.get(`${email}\0${deviceID}`);
}
export function runStore<T>(request: Request): Promise<RuntimeResponse<T>> {
  const mode = useSettingsStore.getState().storeRuntimeMode;
  const requestTransportEpoch = transportEpoch;
  const job = queue.then(async () => {
    const email = request.email ?? request.account?.email ?? '';
    const key = `${email}\0${request.deviceID}`;
    const epoch = epochs.get(email) ?? 0;
    const stored = useAccountsStore
      .getState()
      .accounts.find((account) => account.email === email && account.deviceIdentifier === request.deviceID);
    const state = states.get(key) ?? request.state ?? stored?.runtimeState;
    const result = JSON.parse(
      await exchange(JSON.stringify({ ...request, state }), mode, requestTransportEpoch),
    ) as RuntimeResponse<T>;
    if ((epochs.get(email) ?? 0) !== epoch) throw new Error('Account removed during the request');
    if (result.state?.records) {
      states.set(key, result.state);
      const current = useAccountsStore
        .getState()
        .accounts.find((account) => account.email === email && account.deviceIdentifier === request.deviceID);
      if (current) await useAccountsStore.getState().updateAccount({ ...current, runtimeState: result.state });
    }
    return result;
  });
  queue = job.then(
    () => {},
    () => {},
  );
  return job;
}
export function storeRequest(operation: string, account: Account, app: Software, versionID?: string): Request {
  return {
    operation,
    deviceID: account.deviceIdentifier,
    state: account.runtimeState,
    account: {
      email: account.email,
      password: account.password,
      passwordToken: account.passwordToken,
      directoryServicesIdentifier: account.directoryServicesIdentifier,
      storeFront: account.store,
      pod: account.pod,
    },
    app: { trackId: app.id, bundleId: app.bundleID, trackName: app.name, version: app.version, price: app.price ?? 0 },
    versionID,
  };
}
