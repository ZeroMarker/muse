// The REPL: evaluate editor code with the DSL in scope, producing a Pattern.

import { DSL, Pattern, toPattern, type PatLike } from "./dsl";

const NAMES = Object.keys(DSL);
const VALUES = NAMES.map((k) => (DSL as Record<string, unknown>)[k]);

export type EvalResult =
  | { ok: true; pattern: Pattern; ms: number }
  | { ok: false; error: string; ms: number };

/**
 * Evaluate `code`. Uses direct `eval` inside a scope where every DSL name is
 * bound, so multi-statement code works and the completion value (last
 * expression) is the result — JavaScript semantics, Sonic-Pi style.
 */
export function evaluate(code: string): EvalResult {
  const t0 = performance.now();
  try {
    const fn = new Function(
      ...NAMES,
      `"use strict"; return eval(${JSON.stringify(code)});`,
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
    return {
      ok: false,
      ms: performance.now() - t0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
