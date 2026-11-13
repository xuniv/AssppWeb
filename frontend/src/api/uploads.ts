import { apiDelete, apiGet, authHeaders } from './client';

export interface UploadedPackage {
  id: string;
  software: { bundleID: string; name: string; version: string };
  fileSize: number;
  createdAt: string;
  installUrl: string;
  manifestUrl: string;
}

export const listUploads = () => apiGet<UploadedPackage[]>('/api/uploads');
export const deleteUpload = (id: string) => apiDelete(`/api/uploads/${encodeURIComponent(id)}`);

export function uploadIpa(
  file: File,
  onProgress: (percent: number) => void,
  signal: AbortSignal,
): Promise<UploadedPackage> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const cleanup = () => signal.removeEventListener('abort', abort);
    xhr.open('POST', '/api/uploads');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    for (const [key, value] of Object.entries(authHeaders())) xhr.setRequestHeader(key, value);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      cleanup();
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status !== 201) throw new Error(data.error || `HTTP ${xhr.status}`);
        resolve(data);
      } catch (error) {
        reject(error);
      }
    };
    xhr.onerror = () => {
      cleanup();
      reject(new Error('Upload connection failed'));
    };
    xhr.onabort = () => {
      cleanup();
      reject(new DOMException('Upload cancelled', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      cleanup();
      reject(new DOMException('Upload cancelled', 'AbortError'));
      return;
    }
    xhr.send(file);
  });
}
