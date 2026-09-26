// The user-facing DSL: pattern values, combinators and control setters.
// Everything here builds plain IR nodes; nothing touches wasm directly.

import { CTL, type Pat, atom, rest } from "./ir";
import { mini } from "./mini";

/** Anything acceptable where a pattern is expected. */
export type PatLike = Pattern | Pat | string | number | PatLike[];

/** A pattern value. All combinators return new Patterns (immutable). */
export class Pattern {
  constructor(readonly pat: Pat) {}

  fast(k: number): Pattern {
    return new Pattern({ t: "fast", k, kid: this.pat });
  }

  slow(k: number): Pattern {
    return new Pattern({ t: "fast", k: 1 / k, kid: this.pat });
  }

  rev(): Pattern {
    return new Pattern({ t: "rev", kid: this.pat });
  }

  every(n: number, f: Transform): Pattern {
    return new Pattern({ t: "every", n, step: apply(f, this.pat), kid: this.pat });
  }

  sometimes(p: number, f: Transform): Pattern {
    return new Pattern({ t: "sometimes", p, step: apply(f, this.pat), kid: this.pat });
  }

  chunk(n: number, f: Transform): Pattern {
    return new Pattern({ t: "chunk", n, step: apply(f, this.pat), kid: this.pat });
  }

  shift(d: number): Pattern {
    return new Pattern({ t: "shift", d, kid: this.pat });
  }

  struct(mask: string): Pattern {
    return new Pattern({ t: "struct", mask, kid: this.pat });
  }

  echo(repeats = 3, cycles = 0.25, feedback = 0.5): Pattern {
    return echo(repeats, cycles, feedback, this);
  }

  chorus(depth = 0.01): Pattern {
    return chorus(depth, this);
  }

  sound(name: string): Pattern {
    return new Pattern({ t: "setsound", sound: name, kid: this.pat });
  }

  gain(v: number): Pattern {
    return ctlSet(CTL.gain, v, this.pat);
  }

  cutoff(v: number): Pattern {
    return ctlSet(CTL.cutoff, v, this.pat);
  }

  res(v: number): Pattern {
    return ctlSet(CTL.resonance, v, this.pat);
  }

  pan(v: number): Pattern {
    return ctlSet(CTL.pan, v, this.pat);
  }

  attack(v: number): Pattern {
    return ctlSet(CTL.attack, v, this.pat);
  }

  decay(v: number): Pattern {
    return ctlSet(CTL.decay, v, this.pat);
  }

  sustain(v: number): Pattern {
    return ctlSet(CTL.sustain, v, this.pat);
  }

  release(v: number): Pattern {
    return ctlSet(CTL.release, v, this.pat);
  }

  delay(v: number): Pattern {
    return ctlSet(CTL.delay, v, this.pat);
  }

  speed(v: number): Pattern {
    return ctlSet(CTL.speed, v, this.pat);
  }

  crush(v: number): Pattern {
    return ctlSet(CTL.crush, v, this.pat);
  }

  note(v: number | string): Pattern {
    if (typeof v === "string") {
      // note("c3 e3 g3") — each token carries its own pitch
      return toPattern(v);
    }
    return ctlSet(CTL.note, v, this.pat);
  }

  transpose(semis: number): Pattern {
    return new Pattern({ t: "addctl", slot: CTL.note, d: semis, kid: this.pat });
  }
}

export type Transform = Pattern | Pat | ((p: Pattern) => Pattern | Pat) | string;

function ctlSet(slot: number, v: number, kid: Pat): Pattern {
  return new Pattern({ t: "setctl", slot, v, kid });
}

/** Coerce any PatLike into a Pattern. */
export function toPattern(x: PatLike): Pattern {
  if (x instanceof Pattern) return x;
  if (typeof x === "string") return new Pattern(mini(x));
  if (typeof x === "number") return new Pattern(atom("saw", x));
  if (Array.isArray(x)) {
    if (x.length === 0) return new Pattern(rest);
    if (x.length === 1) return toPattern(x[0]);
    return new Pattern({ t: "cat", kids: x.map((k) => toPattern(k).pat) });
  }
  throw new TypeError(`cannot use value as a pattern: ${JSON.stringify(x)}`);
}

function apply(f: Transform, kid: Pat): Pat {
  if (typeof f === "function") return toPattern(f(new Pattern(kid))).pat;
  return toPattern(f).pat;
}

// ---------------------------------------------------------------------------
// Combinators (free functions — what you type in the editor)
// ---------------------------------------------------------------------------

export const silence = new Pattern(rest);

/** Mini-notation as a function: `p("bd [hh hh] <sn cp>")`. */
export function p(src: string): Pattern {
  return new Pattern(mini(src));
}

export function stack(...xs: PatLike[]): Pattern {
  if (xs.length === 0) return silence;
  if (xs.length === 1) return toPattern(xs[0]);
  return new Pattern({ t: "overlay", kids: xs.map((x) => toPattern(x).pat) });
}

export function cat(...xs: PatLike[]): Pattern {
  if (xs.length === 0) return silence;
  if (xs.length === 1) return toPattern(xs[0]);
  return new Pattern({ t: "cat", kids: xs.map((x) => toPattern(x).pat) });
}

/** Per-cycle alternation — the `<a b>` of mini-notation, as a function. */
export function alt(...xs: PatLike[]): Pattern {
  if (xs.length === 0) return silence;
  if (xs.length === 1) return toPattern(xs[0]);
  return new Pattern({ t: "altern", kids: xs.map((x) => toPattern(x).pat) });
}

export function fast(k: number, x: PatLike): Pattern {
  return toPattern(x).fast(k);
}

export function slow(k: number, x: PatLike): Pattern {
  return toPattern(x).slow(k);
}

export function rev(x: PatLike): Pattern {
  return toPattern(x).rev();
}

export function every(n: number, f: Transform, x: PatLike): Pattern {
  return toPattern(x).every(n, f);
}

export function sometimes(prob: number, f: Transform, x: PatLike): Pattern {
  return toPattern(x).sometimes(prob, f);
}

export function chunk(n: number, f: Transform, x: PatLike): Pattern {
  return toPattern(x).chunk(n, f);
}

export function shift(d: number, x: PatLike): Pattern {
  return toPattern(x).shift(d);
}

export function struct(mask: string, x: PatLike): Pattern {
  return toPattern(x).struct(mask);
}

/** Euclidean rhythm: k hits distributed over n steps (optional rotation). */
export function euclid(k: number, n: number, x: PatLike, rot = 0): Pattern {
  k = Math.max(0, Math.trunc(k));
  n = Math.max(1, Math.trunc(n));
  const hits = new Set<number>();
  for (let i = 0; i < k; i++) {
    // ceil distributes evenly with the longest run first: B(3,8) = x..x..x.
    hits.add((Math.ceil((i * n) / k) + Math.trunc(rot)) % n);
  }
  let mask = "";
  for (let i = 0; i < n; i++) mask += hits.has(i) ? "x" : ".";
  return toPattern(x).struct(mask);
}

export function sound(name: string, x: PatLike): Pattern {
  return toPattern(x).sound(name);
}

// --- control setters -------------------------------------------------------

function ctlFn(slot: number) {
  return (v: number, x: PatLike) => ctlSet(slot, v, toPattern(x).pat);
}

export const gain = ctlFn(CTL.gain);
export const cutoff = ctlFn(CTL.cutoff);
export const res = ctlFn(CTL.resonance);
export const pan = ctlFn(CTL.pan);
export const attack = ctlFn(CTL.attack);
export const decay = ctlFn(CTL.decay);
export const sustain = ctlFn(CTL.sustain);
export const release = ctlFn(CTL.release);
export const delay = ctlFn(CTL.delay);
export const speed = ctlFn(CTL.speed);
export const crush = ctlFn(CTL.crush);

/**
 * Set the pitch of a pattern.
 *  - `note(60, pat)`   — force midi 60 on every event
 *  - `note("c3 e3")`   — mini-notation of note names
 */
export function note(v: number | string, x?: PatLike): Pattern {
  if (x === undefined) {
    if (typeof v === "string") return toPattern(v);
    return new Pattern(atom("saw", v));
  }
  if (typeof v === "string") throw new TypeError("note(string, pat) is ambiguous — use note(string) or note(number, pat)");
  return ctlSet(CTL.note, v, toPattern(x).pat);
}

/** Transpose midi notes by a delta (relative — unlike note()). */
export function transpose(semis: number, x: PatLike): Pattern {
  return toPattern(x).transpose(semis);
}

/** Cycle-synced repeats; includes the original and up to eight echoes. */
export function echo(repeats: number, cycles: number, feedback: number, x: PatLike): Pattern {
  if (!Number.isInteger(repeats) || repeats < 0 || repeats > 8 || !Number.isFinite(cycles) || cycles <= 0
      || !Number.isFinite(feedback) || feedback < 0 || feedback > 1) throw new Error("echo expects 0–8 repeats, positive cycles and feedback 0–1");
  const original = toPattern(x);
  return stack(original, ...Array.from({ length: repeats }, (_, i) =>
    original.shift(cycles * (i + 1)).gain(feedback ** (i + 1))));
}

/** Stereo detune: dry centre plus quieter detuned left and right voices. */
export function chorus(depth: number, x: PatLike): Pattern {
  if (!Number.isFinite(depth) || depth < 0 || depth > 0.1) throw new Error("chorus depth must be 0–0.1");
  const original = toPattern(x);
  return stack(original.gain(0.5), original.speed(1 - depth).pan(0).gain(0.25), original.speed(1 + depth).pan(1).gain(0.25));
}

// --- sugar -----------------------------------------------------------------

/** Map a control function over a pattern of numbers/strings. */
export function mapCtl(x: PatLike, f: (q: Pattern) => Pattern): Pattern {
  return f(toPattern(x));
}

export const DSL = {
  Pattern,
  p,
  stack,
  cat,
  alt,
  fast,
  slow,
  rev,
  every,
  sometimes,
  chunk,
  shift,
  struct,
  euclid,
  sound,
  gain,
  cutoff,
  res,
  pan,
  attack,
  decay,
  sustain,
  release,
  delay,
  speed,
  crush,
  note,
  transpose,
  echo,
  chorus,
  silence,
  toPattern,
} as const;

export type DslName = keyof typeof DSL;
