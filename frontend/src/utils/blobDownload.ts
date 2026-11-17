export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename.replace(/[\\/:*?"<>|\x00-\x1f]/g, '-');
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Allow the browser's download navigation to acquire the Blob first.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
