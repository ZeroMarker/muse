import EvaluateWorker from "./audio/evaluate-worker?worker";
import { Pattern } from "./dsl";
import type { EvalResult } from "./repl";

/** Each evaluation has its own disposable worker; Stop can interrupt loops. */
export function evaluateAsync(code: string, signal?: AbortSignal): Promise<EvalResult> {
  if (signal?.aborted) return Promise.resolve({ ok: false, error: "evaluation cancelled", ms: 0 });
  return new Promise((resolve) => {
    const start = performance.now();
    const worker = new EvaluateWorker();
    const finish = (result: EvalResult) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      resolve(result);
    };
    const fail = (error: string) => finish({ ok: false, error, ms: performance.now() - start });
    const abort = () => fail("evaluation cancelled");
    const timeout = setTimeout(() => fail("evaluation timed out after 2 seconds; check loops or pattern size"), 2000);
    signal?.addEventListener("abort", abort, { once: true });
    worker.onerror = (event) => { event.preventDefault(); fail(event.message); };
    worker.onmessageerror = () => fail("could not receive evaluated pattern");
    worker.onmessage = (event) => {
      const result = event.data;
      finish(result.ok ? { ok: true, pattern: new Pattern(result.pat), ms: result.ms } : result);
    };
    try { worker.postMessage(code); } catch (error) { fail(String(error)); }
  });
}
