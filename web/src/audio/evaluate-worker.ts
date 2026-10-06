import { evaluate } from "../repl";
import { encode } from "../ir";

self.onmessage = (event: MessageEvent<string>) => {
  const result = evaluate(event.data);
  if (!result.ok) { self.postMessage(result); return; }
  try {
    // Validate the complete tree before cloning it back to the UI.
    encode(result.pattern.pat);
    self.postMessage({ ok: true, pat: result.pattern.pat, ms: result.ms });
  } catch (error) {
    self.postMessage({ ok: false, error: String(error), ms: result.ms });
  }
};
