import { encodeWav as encodePortableWav } from "../web/src/offline";
export { renderOffline, SAMPLE_RATE } from "../web/src/offline";

export function encodeWav(samples: Int16Array, sampleRate: number, channels: number): Buffer {
  return Buffer.from(encodePortableWav(samples, sampleRate, channels));
}

export function rms(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}
