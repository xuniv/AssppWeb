import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import UnfairPlayPanel from '../../src/components/UnfairPlay/UnfairPlayPanel';
import { runUnfairPlay } from '../../src/apple/unfairPlay';
import { runServerUnfairPlay } from '../../src/api/unfairplay';
import { downloadBlob } from '../../src/utils/blobDownload';
import { storeUnfairPlayModels } from '../../src/store/unfairplayModels';

const fixtures = vi.hoisted(() => ({ first: new Blob(['one']), second: new Blob(['two']) }));
vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});
vi.mock('../../src/api/client', () => ({
  apiGet: vi.fn(async () => ({ serverUnfairplayAvailable: true })),
  authHeaders: () => ({ 'X-Access-Token': 'synthetic' }),
}));
vi.mock('../../src/utils/runtimeTransport', () => ({ serverRuntimeTransportAllowed: () => true }));
vi.mock('../../src/apple/unfairPlay', () => ({ runUnfairPlay: vi.fn() }));
vi.mock('../../src/api/unfairplay', async (load) => ({
  ...(await load<typeof import('../../src/api/unfairplay')>()),
  runServerUnfairPlay: vi.fn(),
}));
vi.mock('../../src/utils/blobDownload', () => ({ downloadBlob: vi.fn() }));
vi.mock('../../src/store/unfairplayModels', () => ({
  listUnfairPlayModels: vi.fn(async () => [
    { id: 'one', name: 'one.bin', size: 4184, version: 2, data: fixtures.first },
    { id: 'two', name: 'two.bin', size: 8708, version: 3, data: fixtures.second },
  ]),
  prepareUnfairPlayModels: vi.fn(async (files: File[]) =>
    files.map((file) => ({ id: 'incoming', name: file.name, size: file.size, data: file, importedAt: '' })),
  ),
  storeUnfairPlayModels: vi.fn(),
  removeUnfairPlayModel: vi.fn(),
}));
const source = {
  name: 'Original.ipa',
  url: '/api/packages/fixture/file?accountHash=synthetic',
  serverSource: { kind: 'package' as const, id: 'fixture', accountHash: 'synthetic' },
};
const output = () => ({
  ipa: new Blob(['new IPA']),
  report: new Blob(['{}']),
  summary: { plaintextVerified: false },
  dispose: vi.fn(async () => {}),
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runUnfairPlay).mockResolvedValue(output());
  vi.mocked(runServerUnfairPlay).mockResolvedValue(output());
});
afterEach(cleanup);
describe('UnfairPlay private processing UI', () => {
  it('defaults to device, streams the original source to its worker, and distinguishes incomplete verification', async () => {
    const user = userEvent.setup();
    const artifact = output();
    vi.mocked(runUnfairPlay).mockResolvedValue(artifact);
    const rendered = render(<UnfairPlayPanel source={source} />);
    expect(screen.getByRole('switch')).not.toBeChecked();
    await user.selectOptions(screen.getByRole('combobox'), 'strip_account_data');
    await user.click(screen.getByRole('button', { name: 'unfairplay.strip_account_data' }));
    await screen.findByText('unfairplay.completed');
    expect(runUnfairPlay).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'strip_account_data',
        input: { url: source.url, headers: { 'X-Access-Token': 'synthetic' } },
        models: [],
      }),
    );
    expect(runServerUnfairPlay).not.toHaveBeenCalled();
    expect(screen.getByText('unfairplay.notVerified')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'unfairplay.download' }));
    expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'Original.stripped.ipa');
    expect(artifact.dispose).not.toHaveBeenCalled();
    rendered.unmount();
    expect(artifact.dispose).toHaveBeenCalledOnce();
  });
  it('requires explicit server selection, sends only checked models and preserves plain-decrypt semantics', async () => {
    const user = userEvent.setup();
    render(<UnfairPlayPanel source={source} />);
    await user.click(await screen.findByRole('checkbox', { name: /one.bin/ }));
    await waitFor(() => expect(screen.getByRole('switch')).toBeEnabled());
    await user.click(screen.getByRole('switch'));
    expect(screen.getByText('unfairplay.serverTrust')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'unfairplay.decrypt' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'unfairplay.decrypt' }));
    await screen.findByText('unfairplay.completed');
    expect(runServerUnfairPlay).toHaveBeenCalledWith(
      expect.objectContaining({
        source: source.serverSource,
        input: undefined,
        models: [fixtures.first],
        stripAccountData: false,
      }),
    );
    expect(vi.mocked(runUnfairPlay).mock.calls.filter(([request]) => request.operation !== 'model_inspect')).toEqual(
      [],
    );
  });
  it('aborts an in-flight request when mode changes and never falls back to the device', async () => {
    const user = userEvent.setup();
    let signal: AbortSignal | undefined;
    vi.mocked(runServerUnfairPlay).mockImplementation(
      (request) =>
        new Promise((_resolve, reject) => {
          signal = request.signal;
          signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')));
        }),
    );
    render(<UnfairPlayPanel source={source} />);
    await user.selectOptions(screen.getByRole('combobox'), 'strip_account_data');
    await waitFor(() => expect(screen.getByRole('switch')).toBeEnabled());
    await user.click(screen.getByRole('switch'));
    await user.click(screen.getByRole('button', { name: 'unfairplay.strip_account_data' }));
    await waitFor(() => expect(signal).toBeDefined());
    await user.click(screen.getByRole('switch'));
    await screen.findByText('unfairplay.cancelled');
    expect(signal?.aborted).toBe(true);
    expect(runUnfairPlay).not.toHaveBeenCalled();
  });
  it('rejects an oversized model before starting a worker or saving private data', async () => {
    render(<UnfairPlayPanel source={source} />);
    fireEvent.change(screen.getByLabelText('unfairplay.importModels'), {
      target: { files: [new File([new Uint8Array(9000)], 'large.bin')] },
    });
    await screen.findByText('unfairplay.importFailed');
    expect(runUnfairPlay).not.toHaveBeenCalled();
    expect(storeUnfairPlayModels).not.toHaveBeenCalled();
  });
  it('validates imported models on this device before storing them, even when server mode is selected', async () => {
    const user = userEvent.setup();
    const order: string[] = [];
    vi.mocked(runUnfairPlay).mockImplementation(async () => {
      order.push('validated');
      return { ...output(), summary: { modelVersions: [2, 3, 2] } };
    });
    vi.mocked(storeUnfairPlayModels).mockImplementation(async () => {
      order.push('stored');
      return [];
    });
    render(<UnfairPlayPanel source={source} />);
    await waitFor(() => expect(screen.getByRole('switch')).toBeEnabled());
    await user.click(screen.getByRole('switch'));
    fireEvent.change(screen.getByLabelText('unfairplay.importModels'), {
      target: { files: [new File([new Uint8Array(4184)], 'multi.bin')] },
    });
    await waitFor(() => expect(order).toEqual(['validated', 'stored']));
    expect(runUnfairPlay).toHaveBeenCalledWith(expect.objectContaining({ operation: 'model_inspect' }));
    expect(vi.mocked(runUnfairPlay).mock.calls[0][0].models).toHaveLength(3);
    expect(runServerUnfairPlay).not.toHaveBeenCalled();
  });
  it('does not fall back to the local worker after a server failure', async () => {
    const user = userEvent.setup();
    vi.mocked(runServerUnfairPlay).mockRejectedValue(new Error('synthetic failure'));
    render(<UnfairPlayPanel source={source} />);
    await user.selectOptions(screen.getByRole('combobox'), 'strip_account_data');
    await waitFor(() => expect(screen.getByRole('switch')).toBeEnabled());
    await user.click(screen.getByRole('switch'));
    await user.click(screen.getByRole('button', { name: 'unfairplay.strip_account_data' }));
    await screen.findByText('unfairplay.failed');
    expect(runServerUnfairPlay).toHaveBeenCalledOnce();
    expect(runUnfairPlay).not.toHaveBeenCalled();
  });
  it('requires trusted V2 metadata for portable macOS SINF conversion', async () => {
    const user = userEvent.setup();
    render(<UnfairPlayPanel source={source} />);
    await user.click(await screen.findByRole('checkbox', { name: /two.bin/ }));
    await user.selectOptions(screen.getByRole('combobox'), 'convert_ipa_macos');
    expect(screen.getByRole('button', { name: 'unfairplay.convert_ipa_macos' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /two.bin/ }));
    await user.click(screen.getByRole('checkbox', { name: /one.bin/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'unfairplay.convert_ipa_macos' })).toBeEnabled());
  });
  it('stores individually valid mixed model collections without treating them as a valid crypto selection', async () => {
    vi.mocked(runUnfairPlay).mockResolvedValue({
      ...output(),
      summary: { modelVersions: [2, 3, 1], registryCompatible: false },
    });
    render(<UnfairPlayPanel source={source} />);
    fireEvent.change(screen.getByLabelText('unfairplay.importModels'), {
      target: { files: [new File([new Uint8Array(4176)], 'legacy.bin')] },
    });
    await waitFor(() =>
      expect(storeUnfairPlayModels).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ id: 'incoming', version: 1 })]),
      ),
    );
    expect(screen.getByRole('button', { name: 'unfairplay.decrypt' })).toBeDisabled();
  });
  it('disables crypto operations when the core rejects the selected combination', async () => {
    const user = userEvent.setup();
    vi.mocked(runUnfairPlay).mockResolvedValue({ ...output(), summary: { registryCompatible: false } });
    render(<UnfairPlayPanel source={source} />);
    await user.click(await screen.findByRole('checkbox', { name: /one.bin/ }));
    await screen.findByText('unfairplay.incompatibleModels');
    expect(screen.getByRole('button', { name: 'unfairplay.decrypt' })).toBeDisabled();
    expect(runServerUnfairPlay).not.toHaveBeenCalled();
  });
});
