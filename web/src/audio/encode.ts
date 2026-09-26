import { FFmpeg } from "@ffmpeg/ffmpeg";
import classWorkerURL from "@ffmpeg/ffmpeg/worker?worker&url";
import coreURL from "@ffmpeg/core?url";
import wasmURL from "@ffmpeg/core/wasm?url";
import { EXPORT_FORMATS, type ExportFormat } from "../export-formats";

/** Same-origin single-thread encoder; no external CDN or shared memory. */
export async function encodeAudio(wav: Uint8Array, format: ExportFormat, baseURL: string, onPhase: (phase: string) => void): Promise<Uint8Array<ArrayBuffer>> {
  const ffmpeg = new FFmpeg();
  let lastLog = "";
  ffmpeg.on("log", ({ message }) => { lastLog = message; });
  try {
    onPhase("loading encoder…");
    const loading = new AbortController();
    const timeout = setTimeout(() => loading.abort(), 90000);
    try {
      await ffmpeg.load({
        classWorkerURL: new URL(classWorkerURL, baseURL).href,
        coreURL: new URL(coreURL, baseURL).href,
        wasmURL: new URL(wasmURL, baseURL).href,
      }, { signal: loading.signal });
    } catch (error) {
      if (loading.signal.aborted) throw new Error("encoder loading timed out; retry or choose WAV/MIDI");
      throw error;
    } finally { clearTimeout(timeout); }
    onPhase("encoding " + EXPORT_FORMATS[format].label + "…");
    await ffmpeg.writeFile("input.wav", wav);
    const filename = "output." + EXPORT_FORMATS[format].extension;
    const status = await ffmpeg.exec(["-i", "input.wav", "-vn", "-map_metadata", "-1", ...EXPORT_FORMATS[format].args, filename], 300000);
    if (status !== 0) throw new Error("encoding failed: " + lastLog);
    const output = await ffmpeg.readFile(filename);
    if (typeof output === "string") throw new Error("encoder returned text instead of audio");
    return new Uint8Array(output);
  } finally { ffmpeg.terminate(); }
}
