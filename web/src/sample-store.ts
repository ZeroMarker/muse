import { validateSample, validateSampleBudget, type SampleData } from "./samples";

type SavedSample = SampleData & { name: string };

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("muse.samples.v1", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("samples", { keyPath: "name" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction("samples", mode);
      const request = operation(tx.objectStore("samples"));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error ?? new Error("sample storage transaction aborted"));
      tx.onerror = () => reject(tx.error ?? new Error("sample storage failed"));
    });
  } finally { db.close(); }
}

export async function readSamples(): Promise<SavedSample[]> {
  const samples = await transaction<SavedSample[]>("readonly", (store) => store.getAll());
  for (const sample of samples) validateSample(sample.name, sample);
  validateSampleBudget(new Map(samples.map(({ name, ...sample }) => [name, sample])));
  return samples;
}

export async function saveSample(name: string, sample: SampleData): Promise<void> {
  validateSample(name, sample);
  await transaction("readwrite", (store) => store.put({ name, ...sample }));
}

export async function deleteSample(name: string): Promise<void> {
  await transaction("readwrite", (store) => store.delete(name));
}
