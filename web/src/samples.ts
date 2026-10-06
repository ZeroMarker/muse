export interface SampleData { data: Float32Array; rate: number }

export function validateSampleName(name: string): void {
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,126}$/.test(name)) {
    throw new Error("sample name must start with a letter and contain only letters, numbers or underscores (maximum 127 characters)");
  }
}

export function validateSample(name: string, sample: SampleData): void {
  validateSampleName(name);
  if (!(sample.data instanceof Float32Array) || !sample.data.length ||
      !Number.isFinite(sample.rate) || sample.rate < 8000 || sample.rate > 192000 ||
      sample.data.length > sample.rate * 30) {
    throw new Error("sample must contain mono PCM at 8–192 kHz and be at most 30 seconds");
  }
}

/** Limit the source PCM held by a session; playback/export also copy it. */
export function validateSampleBudget(samples: ReadonlyMap<string, SampleData>, name?: string, sample?: SampleData | number): void {
  let bytes = typeof sample === "number" ? sample : sample?.data.byteLength ?? 0;
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("invalid sample PCM size");
  for (const [key, value] of samples) if (key !== name) bytes += value.data.byteLength;
  if (bytes > 128 * 1024 * 1024) throw new Error("samples exceed the 128 MiB total PCM limit; delete unused samples");
}
