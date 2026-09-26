import { WasmCore } from "../wasm";
import { renderOffline, encodeWav, SAMPLE_RATE } from "../offline";
import { evaluate } from "../repl";

self.onmessage = async (event: MessageEvent) => {
  try {
    const { code, seconds, cps, wasmUrl, samples } = event.data;
    const result = evaluate(code);
    if (!result.ok) throw new Error(result.error);
    const core = await WasmCore.load(wasmUrl);
    const pcm = renderOffline(core, result.pattern.pat, seconds, cps, SAMPLE_RATE, new Map(samples));
    const wav = encodeWav(pcm, SAMPLE_RATE, 2);
    self.postMessage({ wav }, { transfer: [wav.buffer] });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
