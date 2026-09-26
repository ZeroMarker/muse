import { WasmCore } from "../wasm";
import { renderOffline, encodeWav, SAMPLE_RATE } from "../offline";
import { renderMidi } from "../midi";
import { EXPORT_FORMATS, parseExportFormat } from "../export-formats";
import { evaluate } from "../repl";

self.onmessage = async (event: MessageEvent) => {
  try {
    const { code, seconds, cps, wasmUrl, samples, format: selectedFormat, baseURL } = event.data;
    const sampleEntries: [string, { data: Float32Array; rate: number }][] = samples ?? [];
    const result = evaluate(code);
    if (!result.ok) throw new Error(result.error);
    const core = await WasmCore.load(wasmUrl);
    const format = parseExportFormat(selectedFormat ?? "wav");
    const metadata = EXPORT_FORMATS[format];
    if (format === "mid") {
      const bytes = renderMidi(core, result.pattern.pat, seconds, cps, new Set(sampleEntries.map(([name]) => name)));
      self.postMessage({ bytes, extension: metadata.extension, mime: metadata.mime }, { transfer: [bytes.buffer] });
      return;
    }
    const pcm = renderOffline(core, result.pattern.pat, seconds, cps, SAMPLE_RATE, new Map(sampleEntries));
    const wav = encodeWav(pcm, SAMPLE_RATE, 2);
    const bytes = format === "wav" ? wav : await (await import("./encode")).encodeAudio(wav, format, baseURL,
      (phase) => self.postMessage({ phase }));
    self.postMessage({ bytes, extension: metadata.extension, mime: metadata.mime }, { transfer: [bytes.buffer] });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
