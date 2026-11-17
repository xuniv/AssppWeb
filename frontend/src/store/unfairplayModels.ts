import { openDB } from 'idb';

export interface UnfairPlayModel {
  id: string;
  name: string;
  size: number;
  importedAt: string;
  data: Blob;
  version?: number;
}

const sizes = new Set([4176, 4184, 8708]);
const maximumModels = 256;
const database = () =>
  openDB('asspp-unfairplay-private-models', 1, {
    upgrade(db) {
      db.createObjectStore('models', { keyPath: 'id' });
    },
  });

// Binary enrollment models have their own private browser database. Account
// exports and the immutable public-image cache never include these records.
export async function listUnfairPlayModels(): Promise<UnfairPlayModel[]> {
  const db = await database();
  try {
    return (await db.getAll('models'))
      .map((model) => ({
        ...model,
        data: model.data instanceof Blob ? model.data : new Blob([model.data], { type: 'application/octet-stream' }),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    db.close();
  }
}

export async function prepareUnfairPlayModels(files: File[]): Promise<UnfairPlayModel[]> {
  if (!files.length || files.length > maximumModels || files.some((file) => !sizes.has(file.size))) {
    throw new Error('invalid_model_size');
  }
  return Promise.all(
    files.map(async (file) => {
      const bytes = await file.arrayBuffer();
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      return {
        id: [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
        name: file.name,
        size: file.size,
        importedAt: new Date().toISOString(),
        data: new Blob([bytes], { type: 'application/octet-stream' }),
      };
    }),
  );
}

export async function storeUnfairPlayModels(records: UnfairPlayModel[]): Promise<UnfairPlayModel[]> {
  // Small binary ArrayBuffers avoid WebKit variants that cannot persist Blob
  // records. Callers still consume Blob views; no base64/localStorage copy.
  const binaryRecords = await Promise.all(
    records.map(async (model) => ({ ...model, data: await model.data.arrayBuffer() })),
  );
  const db = await database();
  try {
    const transaction = db.transaction('models', 'readwrite');
    const existing = new Set(await transaction.store.getAllKeys());
    for (const record of records) existing.add(record.id);
    if (existing.size > maximumModels) {
      transaction.abort();
      throw new Error('model_limit');
    }
    for (const record of binaryRecords) await transaction.store.put(record);
    await transaction.done;
    return records;
  } finally {
    db.close();
  }
}

export async function importUnfairPlayModels(files: File[]): Promise<UnfairPlayModel[]> {
  return storeUnfairPlayModels(await prepareUnfairPlayModels(files));
}

export async function removeUnfairPlayModel(id: string): Promise<void> {
  const db = await database();
  try {
    await db.delete('models', id);
  } finally {
    db.close();
  }
}
