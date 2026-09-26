// The REPL: evaluate editor code with the DSL in scope, producing a Pattern.

import { parse } from "acorn";

import { DSL, Pattern, toPattern, type PatLike } from "./dsl";

const NAMES = Object.keys(DSL);
const VALUES = NAMES.map((k) => (DSL as Record<string, unknown>)[k]);

export type EvalResult =
  | { ok: true; pattern: Pattern; ms: number }
  | { ok: false; error: string; ms: number; line?: number; column?: number };

/**
 * Evaluate `code`. Uses direct `eval` inside a scope where every DSL name is
 * bound, so multi-statement code works and the completion value (last
 * expression) is the result — JavaScript semantics, Sonic-Pi style.
 */
export function evaluate(code: string): EvalResult {
  const t0 = performance.now();
  try {
    parse(code, { ecmaVersion: "latest", locations: true });
    const fn = new Function(
      ...NAMES,
      `"use strict"; return eval(${JSON.stringify(code + "\n//# sourceURL=muse-editor.js")});`,
    );
    const value = fn(...VALUES);
    if (value === undefined || value === null) {
      return {
        ok: false,
        ms: performance.now() - t0,
        error:
          "code must evaluate to a pattern — the last statement should be an expression",
      };
    }
    const pattern = value instanceof Pattern ? value : toPattern(value as PatLike);
    return { ok: true, pattern, ms: performance.now() - t0 };
  } catch (e) {
    const loc = (e as { loc?: { line: number; column: number } })?.loc;
    const frame = e instanceof Error ? /muse-editor\.js:(\d+):(\d+)/.exec(e.stack ?? "") : null;
    return {
      line: loc?.line ?? (frame ? Number(frame[1]) : undefined),
      column: loc ? loc.column + 1 : (frame ? Number(frame[2]) : undefined),
      ok: false,
      ms: performance.now() - t0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
