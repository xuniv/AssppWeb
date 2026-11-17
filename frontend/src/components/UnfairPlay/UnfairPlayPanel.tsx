import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Alert from '../common/Alert';
import Spinner from '../common/Spinner';
import { useToastStore } from '../../store/toast';
import {
  prepareUnfairPlayModels,
  storeUnfairPlayModels,
  listUnfairPlayModels,
  removeUnfairPlayModel,
} from '../../store/unfairplayModels';
import { apiGet, authHeaders } from '../../api/client';
import { runServerUnfairPlay, safeUnfairPlaySummary, unfairPlaySummaryReport } from '../../api/unfairplay';
import { downloadBlob } from '../../utils/blobDownload';
import { formatBytes } from '../../utils/format';
import { serverRuntimeTransportAllowed } from '../../utils/runtimeTransport';
import type { UnfairPlayModel } from '../../store/unfairplayModels';
import type { UnfairPlayOperation, UnfairPlayResult } from '../../api/unfairplay';

const button =
  'min-h-11 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium transition-colors hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800';
export interface IpaSource {
  name: string;
  url: string;
  serverSource: { kind: 'package' | 'upload'; id: string; accountHash?: string };
}

export default function UnfairPlayPanel({ source }: { source?: IpaSource }) {
  const { t } = useTranslation();
  const [models, setModels] = useState<UnfairPlayModel[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [compatible, setCompatible] = useState<boolean | null>(true);
  const [file, setFile] = useState<File | null>(null);
  const [operation, setOperation] = useState<UnfairPlayOperation>('decrypt');
  const [strip, setStrip] = useState(false);
  const [server, setServer] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<UnfairPlayResult | null>(null);
  const controller = useRef<AbortController | null>(null);
  const currentResult = useRef<UnfairPlayResult | null>(null);
  const allowed = serverRuntimeTransportAllowed();
  function releaseResult(value: UnfairPlayResult | null) {
    void value?.dispose?.().catch(() => useToastStore.getState().addToast(t('unfairplay.cleanupFailed'), 'error'));
  }
  function replaceResult(value: UnfairPlayResult | null) {
    releaseResult(currentResult.current);
    currentResult.current = value;
    setResult(value);
  }

  useEffect(() => {
    let active = true;
    listUnfairPlayModels()
      .then((items) => {
        if (active) setModels(items);
      })
      .catch(() => {
        if (active) setError(t('unfairplay.storageFailed'));
      });
    apiGet<{ serverUnfairplayAvailable?: boolean }>('/api/settings')
      .then((info) => {
        if (active) setAvailable(info.serverUnfairplayAvailable === true);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [t]);
  useEffect(
    () => () => {
      controller.current?.abort();
      releaseResult(currentResult.current);
    },
    [],
  );

  useEffect(() => {
    if (!selected.length) {
      setCompatible(true);
      return;
    }
    const pending = new AbortController();
    setCompatible(null);
    const timer = setTimeout(async () => {
      try {
        const chosen = models.filter((model) => selected.includes(model.id));
        const inspection = await (
          await import('../../apple/unfairPlay')
        ).runUnfairPlay({
          operation: 'model_inspect',
          models: chosen.map((model) => model.data),
          signal: pending.signal,
        });
        if (!pending.signal.aborted)
          setCompatible(
            inspection.summary.registryCompatible !== false &&
              !(chosen.length > 1 && chosen.some((model) => model.version === 1)),
          );
        releaseResult(inspection);
      } catch {
        if (!pending.signal.aborted) setCompatible(false);
      }
    }, 120);
    return () => {
      clearTimeout(timer);
      pending.abort();
    };
  }, [selected, models]);

  async function importModels(files: File[]) {
    if (busy || !files.length) return;
    setError('');
    replaceResult(null);
    setBusy(true);
    setStage('initializing');
    const pending = new AbortController();
    controller.current = pending;
    try {
      if (files.length > 256 || files.some((file) => ![4176, 4184, 8708].includes(file.size)))
        throw new Error('invalid_model_size');
      const imported = await prepareUnfairPlayModels(files);
      const registry = new Map((await listUnfairPlayModels()).map((model) => [model.id, model]));
      for (const model of imported) registry.set(model.id, model);
      if (registry.size > 256) throw new Error('model_limit');
      const inspected = await (
        await import('../../apple/unfairPlay')
      ).runUnfairPlay({
        operation: 'model_inspect',
        models: [...registry.values()].map((model) => model.data),
        stripAccountData: false,
        signal: pending.signal,
      });
      if (pending.signal.aborted) return;
      const versions = safeUnfairPlaySummary(inspected.summary).modelVersions as number[] | undefined;
      if (!versions || versions.length !== registry.size) throw new Error('invalid_model_inspection');
      await storeUnfairPlayModels(
        [...registry.values()].map((model, index) => ({ ...model, version: versions[index] })),
      );
      setModels(await listUnfairPlayModels());
      // Importing private records is separate from choosing which models an
      // operation may use or transfer. New records begin unselected.
    } catch {
      setError(t(pending.signal.aborted ? 'unfairplay.cancelled' : 'unfairplay.importFailed'));
    } finally {
      if (controller.current === pending) {
        controller.current = null;
        setBusy(false);
        setStage('');
      }
    }
  }
  async function removeModel(id: string) {
    try {
      replaceResult(null);
      await removeUnfairPlayModel(id);
      setModels((items) => items.filter((item) => item.id !== id));
      setSelected((items) => items.filter((item) => item !== id));
    } catch {
      setError(t('unfairplay.storageFailed'));
    }
  }
  async function run() {
    if (busy || (operation !== 'model_inspect' && !file && !source)) return;
    setBusy(true);
    setError('');
    replaceResult(null);
    setStage('reading');
    const pending = new AbortController();
    controller.current = pending;
    try {
      const input = operation === 'model_inspect' || source ? undefined : file!;
      const chosen =
        operation === 'strip_account_data'
          ? []
          : models.filter((model) => selected.includes(model.id)).map((model) => model.data);
      const request = {
        operation,
        input,
        models: chosen,
        stripAccountData: strip,
        signal: pending.signal,
        onProgress: (progress: { stage: string }) => {
          if (!pending.signal.aborted) setStage(progress.stage);
        },
      };
      const output = server
        ? await runServerUnfairPlay({
            ...request,
            source: operation !== 'model_inspect' ? source?.serverSource : undefined,
          })
        : await (
            await import('../../apple/unfairPlay')
          ).runUnfairPlay({
            ...request,
            input: operation !== 'model_inspect' && source ? { url: source.url, headers: authHeaders() } : input,
          });
      if (!pending.signal.aborted) {
        const summary = safeUnfairPlaySummary(output.summary);
        replaceResult({ ...output, summary, report: unfairPlaySummaryReport(summary) });
      } else releaseResult(output);
    } catch (failure) {
      if (failure instanceof Error && failure.message === 'unfairplay_cleanup_failed') {
        setError(t('unfairplay.cleanupFailed'));
        return;
      }
      const unavailable =
        failure instanceof Error &&
        ['unfairplay_browser_unsupported', 'unfairplay_storage_unavailable', 'unfairplay_storage_full'].includes(
          failure.message,
        );
      setError(
        t(
          pending.signal.aborted
            ? 'unfairplay.cancelled'
            : unavailable
              ? 'unfairplay.deviceUnavailable'
              : 'unfairplay.failed',
        ),
      );
    } finally {
      if (controller.current === pending) {
        controller.current = null;
        setBusy(false);
        setStage('');
      }
    }
  }
  const name = (source?.name ?? file?.name ?? 'application.ipa').replace(/\.ipa$/i, '');
  const needsModels = !['doctor', 'strip_account_data'].includes(operation);
  const needsCompatible = ['decrypt', 'verify', 'convert_ipa_macos'].includes(operation);
  const unsupportedConversion =
    operation === 'convert_ipa_macos' && models.some((model) => selected.includes(model.id) && model.version !== 2);
  const outputSuffix =
    operation === 'strip_account_data'
      ? 'stripped'
      : operation === 'convert_ipa_macos'
        ? 'macos'
        : strip
          ? 'decrypted.stripped'
          : 'decrypted';
  return (
    <section
      aria-label="UnfairPlay"
      className="space-y-4 rounded-lg border border-gray-200 bg-white p-4 text-gray-900 dark:border-gray-800 dark:bg-gray-900 dark:text-white"
    >
      <h2 className="text-lg font-semibold">UnfairPlay</h2>
      <p className="text-sm text-gray-600 dark:text-gray-400">{t('unfairplay.description')}</p>
      {source ? (
        <p className="break-all text-sm">{source.name}</p>
      ) : (
        <label className="block text-sm">
          {t('unfairplay.input')}
          <input
            type="file"
            accept=".ipa"
            disabled={busy}
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              replaceResult(null);
            }}
            className="mt-2 block w-full min-w-0"
          />
        </label>
      )}
      <fieldset disabled={busy} className="space-y-2">
        <legend className="text-sm font-medium">{t('unfairplay.models')}</legend>
        <p className="text-xs text-gray-500 dark:text-gray-400">{t('unfairplay.privateModels')}</p>
        <label className="block text-sm">
          {t('unfairplay.importModels')}
          <input
            type="file"
            accept=".bin"
            multiple
            onChange={(event) => {
              void importModels(Array.from(event.target.files ?? []));
              event.target.value = '';
            }}
            className="mt-2 block w-full min-w-0"
          />
        </label>
        {models.length === 0 && <p className="text-sm text-gray-500">{t('unfairplay.noModels')}</p>}
        {models.map((model) => (
          <div key={model.id} className="flex items-center gap-2 text-sm">
            <label className="flex min-h-11 min-w-0 flex-1 items-center gap-2">
              <input
                type="checkbox"
                checked={selected.includes(model.id)}
                onChange={(event) => {
                  replaceResult(null);
                  setSelected((current) =>
                    event.target.checked ? [...current, model.id] : current.filter((id) => id !== model.id),
                  );
                }}
              />
              <span className="min-w-0 break-all">
                {model.name} · {formatBytes(model.size)}
                {model.version && ` · v${model.version}`}
              </span>
            </label>
            <button
              type="button"
              className={button}
              onClick={() => downloadBlob(model.data, model.name)}
              aria-label={t('unfairplay.exportModel', { name: model.name })}
            >
              {t('unfairplay.export')}
            </button>
            <button
              type="button"
              className={button}
              onClick={() => void removeModel(model.id)}
              aria-label={t('unfairplay.removeModel', { name: model.name })}
            >
              {t('unfairplay.remove')}
            </button>
          </div>
        ))}
      </fieldset>
      {compatible === false && (
        <p className="text-sm text-amber-700 dark:text-amber-300">{t('unfairplay.incompatibleModels')}</p>
      )}
      {compatible === null && (
        <p role="status" className="text-xs text-gray-500">
          {t('unfairplay.checkingModels')}
        </p>
      )}
      <label className="block text-sm">
        {t('unfairplay.operation')}
        <select
          value={operation}
          disabled={busy}
          onChange={(event) => {
            setOperation(event.target.value as UnfairPlayOperation);
            replaceResult(null);
          }}
          className="mt-2 block min-h-11 w-full rounded-lg border border-gray-300 bg-white p-2 dark:border-gray-700 dark:bg-gray-900"
        >
          {(['decrypt', 'verify', 'doctor', 'model_inspect', 'strip_account_data', 'convert_ipa_macos'] as const).map(
            (value) => (
              <option key={value} value={value}>
                {t(`unfairplay.${value}`)}
              </option>
            ),
          )}
        </select>
      </label>
      {operation === 'convert_ipa_macos' && <p className="text-xs text-gray-500">{t('unfairplay.convertNote')}</p>}
      {operation === 'decrypt' && (
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={strip}
            disabled={busy}
            onChange={(event) => {
              replaceResult(null);
              setStrip(event.target.checked);
            }}
          />
          {t('unfairplay.strip')}
        </label>
      )}
      <div>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            role="switch"
            checked={server}
            disabled={!server && (!available || !allowed)}
            onChange={(event) => {
              controller.current?.abort();
              setServer(event.target.checked);
              replaceResult(null);
            }}
          />
          {t('unfairplay.server')}
        </label>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {server ? t('unfairplay.serverTrust') : t('unfairplay.deviceTrust')}
        </p>
        {allowed && available === false && <p className="text-xs text-gray-500">{t('settings.runtime.unavailable')}</p>}
        {!allowed && <p className="text-xs text-amber-700">{t('settings.runtime.httpsRequired')}</p>}
      </div>
      {error && <Alert type="error">{error}</Alert>}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={
            busy ||
            (operation !== 'model_inspect' && !file && !source) ||
            (needsModels && !selected.length) ||
            (needsCompatible && compatible !== true) ||
            unsupportedConversion
          }
          onClick={() => void run()}
          className={`${button} bg-blue-600 text-white hover:bg-blue-700`}
        >
          {busy ? (
            <>
              <Spinner /> {t('unfairplay.running')}
            </>
          ) : (
            t(`unfairplay.${operation}`)
          )}
        </button>
        {busy && (
          <button type="button" onClick={() => controller.current?.abort()} className={button}>
            {t('unfairplay.cancel')}
          </button>
        )}
      </div>
      {busy && (
        <p role="status" className="text-sm">
          {t(`unfairplay.stages.${stage}`, { defaultValue: t('unfairplay.running') })}
        </p>
      )}
      {result && (
        <div role="status" className="space-y-3">
          <p className="text-sm">{t('unfairplay.completed')}</p>
          {result.summary.ready === false && <p className="text-sm">{t('unfairplay.notReady')}</p>}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            {[
              'modelCount',
              'encryptedImages',
              'decryptedPages',
              'removedLicenseFiles',
              'removedMetadataFields',
              'convertedRecords',
            ]
              .filter((key) => typeof result.summary[key] === 'number')
              .map((key) => (
                <div key={key}>
                  <dt className="text-xs text-gray-500">{t(`unfairplay.metrics.${key}`)}</dt>
                  <dd>{String(result.summary[key])}</dd>
                </div>
              ))}
          </dl>
          {typeof (result.summary.plaintextVerified ?? result.summary.plaintext_verified) === 'boolean' && (
            <p className="text-sm">
              {result.summary.plaintextVerified === true || result.summary.plaintext_verified === true
                ? t('unfairplay.verified')
                : t('unfairplay.notVerified')}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {result.ipa && (
              <button
                type="button"
                onClick={() => downloadBlob(result.ipa!, `${name}.${outputSuffix}.ipa`)}
                className={button}
              >
                {t('unfairplay.download')}
              </button>
            )}
            <button
              type="button"
              onClick={() => downloadBlob(result.report, `${name}.unfairplay.json`)}
              className={button}
            >
              {t('unfairplay.report')}
            </button>
          </div>
          {(operation === 'strip_account_data' || (operation === 'decrypt' && strip)) && (
            <p className="text-xs text-gray-500 dark:text-gray-400">{t('unfairplay.stripNote')}</p>
          )}
        </div>
      )}
    </section>
  );
}
