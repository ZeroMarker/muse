import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { validateSample, validateSampleName, validateSampleBudget, type SampleData } from "../web/src/samples";

/** Decode external audio through system FFmpeg, with bounded time and output. */
export function loadSamples(specs: string[]): Map<string, SampleData> {
  const samples = new Map<string, SampleData>();
  for (const spec of specs) {
    const separator = spec.indexOf("=");
    if (separator < 1 || separator === spec.length - 1) throw new Error("--sample needs name=path");
    const name = spec.slice(0, separator);
    validateSampleName(name);
    if (samples.has(name)) throw new Error(`duplicate sample name: ${name}`);
    const file = resolve(spec.slice(separator + 1));
    if (statSync(file).size > 50 * 1024 * 1024) throw new Error("sample file must be smaller than 50 MiB");
    const result = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-i", file, "-map", "0:a:0",
      "-t", "31", "-ac", "1", "-ar", "48000", "-f", "f32le", "-acodec", "pcm_f32le", "pipe:1"],
      { maxBuffer: 8 * 1024 * 1024, timeout: 30000 });
    if (result.error) {
      if ((result.error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("FFmpeg is required to load sample files; install ffmpeg");
      throw new Error(`sample decoding failed: ${result.error.message}`);
    }
    if (result.status !== 0) throw new Error(`sample decoding failed: ${result.stderr.toString().trim()}`);
    const data = new Float32Array(result.stdout.length / 4);
    for (let i = 0; i < data.length; i++) data[i] = result.stdout.readFloatLE(i * 4);
    const sample = { data, rate: 48000 };
    validateSample(name, sample);
    validateSampleBudget(samples, name, sample);
    samples.set(name, sample);
  }
  return samples;
}
