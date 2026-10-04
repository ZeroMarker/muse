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
