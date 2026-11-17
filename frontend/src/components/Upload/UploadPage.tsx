import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { QRCodeSVG } from 'qrcode.react';
import { Link } from 'react-router-dom';
import PageContainer from '../Layout/PageContainer';
import Alert from '../common/Alert';
import Spinner from '../common/Spinner';
import UnfairPlayPanel from '../UnfairPlay/UnfairPlayPanel';
import { deleteUpload, listUploads, uploadIpa } from '../../api/uploads';
import { getErrorMessage } from '../../utils/error';
import { formatBytes } from '../../utils/format';
import type { UploadedPackage } from '../../api/uploads';

const secondaryButton =
  'min-h-11 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800';

export default function UploadPage() {
  const { t } = useTranslation();
  const [items, setItems] = useState<UploadedPackage[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [qrId, setQrId] = useState<string | null>(null);
  const [toolId, setToolId] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    listUploads()
      .then((data) => {
        if (active) setItems(data);
      })
      .catch((err) => {
        if (active) setError(getErrorMessage(err, t('uploads.failed')));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.current?.abort();
    };
  }, [t]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!file || busy) return;
    setError('');
    setNotice('');
    if (!file.name.toLowerCase().endsWith('.ipa')) {
      setError(t('uploads.invalidFile'));
      return;
    }
    setBusy(true);
    setProgress(0);
    const pending = new AbortController();
    controller.current = pending;
    try {
      const item = await uploadIpa(file, setProgress, pending.signal);
      // Refresh because accepting a new IPA may have evicted older uploads.
      setItems(await listUploads());
      setNotice(t('uploads.ready', { name: item.software.name }));
      setFile(null);
      if (input.current) input.current.value = '';
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') setNotice(t('uploads.cancelled'));
      else setError(getErrorMessage(err, t('uploads.failed')));
    } finally {
      controller.current = null;
      setBusy(false);
    }
  }

  async function remove(item: UploadedPackage) {
    if (!window.confirm(t('uploads.confirmDelete', { name: item.software.name }))) return;
    setDeleting(item.id);
    setError('');
    try {
      await deleteUpload(item.id);
      setItems((current) => current.filter((candidate) => candidate.id !== item.id));
    } catch (err) {
      setError(getErrorMessage(err, t('uploads.failed')));
    } finally {
      setDeleting(null);
    }
  }

  async function share(item: UploadedPackage) {
    try {
      await navigator.clipboard.writeText(item.installUrl);
      setNotice(t('uploads.copied'));
    } catch {
      setError(t('uploads.copyFailed'));
    }
  }

  return (
    <PageContainer title={t('uploads.title')}>
      <div className="space-y-6">
        <p className="text-sm text-gray-600 dark:text-gray-400">{t('uploads.description')}</p>
        <Link to="/unfairplay" className="inline-flex min-h-11 items-center text-sm text-blue-600 underline">
          {t('unfairplay.open')}
        </Link>
        <Alert type="warning">{t('uploads.retention')}</Alert>
        {error && <Alert type="error">{error}</Alert>}
        {notice && <Alert type="success">{notice}</Alert>}
        <form
          onSubmit={submit}
          className="space-y-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900"
        >
          <label htmlFor="ipa-file" className="block text-sm font-medium text-gray-900 dark:text-white">
            {t('uploads.chooseFile')}
          </label>
          <input
            id="ipa-file"
            ref={input}
            type="file"
            accept=".ipa"
            disabled={busy}
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            className="block w-full min-w-0 text-sm text-gray-600 file:mr-3 file:rounded-md file:border-0 file:bg-blue-50 file:px-3 file:py-2 file:text-blue-700 dark:text-gray-400 dark:file:bg-gray-800 dark:file:text-blue-400"
          />
          {file && (
            <p className="break-all text-sm text-gray-600 dark:text-gray-400">
              {file.name} · {formatBytes(file.size)}
            </p>
          )}
          {busy && (
            <div role="status" className="space-y-2 text-sm text-gray-600 dark:text-gray-400">
              <p>{progress < 100 ? t('uploads.progress', { percent: progress }) : t('uploads.processing')}</p>
              <progress
                max={100}
                value={progress}
                aria-label={t('uploads.upload')}
                className="h-2 w-full accent-blue-600"
              />
            </div>
          )}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={!file || busy}
              className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              {busy && <Spinner />}
              {t('uploads.upload')}
            </button>
            {busy && (
              <button type="button" onClick={() => controller.current?.abort()} className={secondaryButton}>
                {t('uploads.cancel')}
              </button>
            )}
          </div>
        </form>
        <p className="text-sm text-gray-600 dark:text-gray-400">{t('uploads.installNote')}</p>
        {loading ? (
          <div role="status">
            <Spinner /> {t('loading')}
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-lg border-2 border-dashed border-gray-200 bg-gray-50 p-8 text-center text-sm text-gray-500 dark:border-gray-800 dark:bg-gray-900/30 dark:text-gray-400">
            {t('uploads.empty')}
          </div>
        ) : (
          <div className="space-y-4">
            {items.map((item) => (
              <article
                key={item.id}
                className="space-y-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900"
              >
                <div>
                  <h2 className="break-words text-lg font-semibold text-gray-900 dark:text-white">
                    {item.software.name}
                  </h2>
                  <p className="break-all text-sm text-gray-500 dark:text-gray-400">
                    {item.software.bundleID} · {item.software.version} · {formatBytes(item.fileSize)}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <a
                    href={item.installUrl}
                    className="inline-flex min-h-11 items-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
                  >
                    {t('uploads.install')}
                  </a>
                  <button type="button" onClick={() => share(item)} className={secondaryButton}>
                    {t('uploads.copy')}
                  </button>
                  <button
                    type="button"
                    aria-expanded={qrId === item.id}
                    onClick={() => setQrId(qrId === item.id ? null : item.id)}
                    className={secondaryButton}
                  >
                    {t('uploads.qr')}
                  </button>
                  <button
                    type="button"
                    aria-expanded={toolId === item.id}
                    onClick={() => setToolId(toolId === item.id ? null : item.id)}
                    className={secondaryButton}
                  >
                    UnfairPlay
                  </button>
                  <button
                    type="button"
                    disabled={deleting === item.id}
                    onClick={() => remove(item)}
                    className={`${secondaryButton} text-red-600 dark:text-red-400`}
                  >
                    {t('uploads.delete')}
                  </button>
                </div>
                {toolId === item.id && (
                  <UnfairPlayPanel
                    source={{
                      name: `${item.software.name}_${item.software.version}.ipa`,
                      serverSource: { kind: 'upload', id: item.id },
                      url: `/api/install/uploads/${encodeURIComponent(item.id)}/payload.ipa`,
                    }}
                  />
                )}
                {qrId === item.id && (
                  <div className="inline-block rounded-lg bg-white p-3">
                    <QRCodeSVG value={item.installUrl} size={180} title={t('uploads.qr')} />
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </div>
    </PageContainer>
  );
}
