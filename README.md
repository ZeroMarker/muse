# muse

Live-coded music in the browser — a Strudel/Sonic-Pi-style DSL with a Rust
heart.

```
               Browser
                  │
           Monaco Editor
                  │
             TypeScript
          DSL / UI / REPL
                  │
              Pattern IR
                  │
           WASM boundary
                  │
                Rust
        ┌─────────┼─────────┐
      Clock    Scheduler    DSP
        │
        └──── AudioWorklet
```

## Quick start

```sh
npm install
npm run dev          # builds the wasm + starts vite (http://localhost:5173)
```

Press **ctrl+enter** to run the editor — audio starts on the first run.

```sh
npm test             # 25 rust tests + 30 TS tests + wasm build
npm run build        # production build → dist/
node scripts/e2e.mjs # headless-Chromium end-to-end test (needs `npm run build`)
```

## The pipeline

| Layer | File(s) | Role |
| --- | --- | --- |
| Editor | `web/src/ui/editor.ts` | Monaco, JS syntax, DSL completions/hovers |
| REPL | `web/src/repl.ts` | evaluates editor code with the DSL in scope; last expression is the pattern |
| DSL | `web/src/dsl.ts`, `web/src/mini.ts` | combinators + Tidal-style mini-notation → Pattern IR |
| IR encoder | `web/src/ir.ts` | packs the IR into the wasm-side binary format (`MUSE` magic) |
| WASM bridge | `web/src/wasm.ts` | typed access to the Rust exports, memory alloc/free, error marshalling |
| Clock/Scheduler (Rust) | `crates/muse-core/src/{sched,pattern,ir}.rs` | cycle↔audio-time clock, lookahead query cursor, event packing |
| DSP (Rust) | `crates/muse-core/src/dsp.rs` | voices, drum synths, SVF filter, envelopes, delay, soft clip |
| AudioWorklet | `web/src/audio/processor.js` | second wasm instance; sample-accurate rendering, output meter |
| Engine | `web/src/audio/engine.ts` | transport, 60 ms tick, event posting, hot pattern swap |

Two wasm *instances* run from one artifact: the main-thread instance owns the
pattern + clock + scheduler; the worklet instance owns the DSP. They share no
memory — events cross the port as plain objects `{t, d, c, s}`.

### Design notes

- **Time is cycles.** One cycle = one pass of the pattern. The clock maps
  audio-context seconds to cycles: `cycle(t) = epoch_cycle + (t-epoch_audio)*cps`.
- **Lookahead scheduling.** Every 60 ms the engine asks Rust for events in
  `[cursor, now+300ms)`, converts onsets to absolute audio time and posts them
  to the worklet. The cursor only moves forward, so every onset is scheduled
  exactly once.
- **The worklet has no `fetch` and no `TextEncoder`** (AudioWorkletGlobalScope
  is minimal) — the main thread downloads the wasm and ships the bytes over
  the port; instrument names are written as raw ASCII bytes.
- **NaN discipline.** Control slots not set by the user arrive as `NaN` and are
  replaced with defaults when events are packed; the DSP additionally clamps
  every control defensively (`f64::min(NaN, x) == x` once turned silence into a
  DC offset of 1.0).

## DSL reference

Mini-notation (strings):

```
"bd hh sn"        sequence        "bd [hh hh]"   nested groups
"(bd sn)"         simultaneity    "<bd sn>"       alternate per cycle
"." or "~"        rests           "bd*2" "hh/4"   fast / slow postfix
"c3 e3 g4"        note names      "60 62 64"      midi numbers
```

Functions (also chainable as methods):

```js
stack(a, b)                 // parallel layers
cat(a, b)                   // sequence across one cycle
alt(a, b)                   // one per cycle
fast(k, p)  slow(k, p)      // time warp
rev(p)                      // mirror each cycle
every(4, fast(2), p)        // transform every n-th cycle
sometimes(0.5, rev, p)      // probabilistic transform
chunk(4, fast(2), p)        // cycle split in n slots, transform slot cycle%n
euclid(3, 8, p)             // x..x..x.
struct("x.x.x.", p)         // mask gates the pattern
shift(0.25, p)              // move in cycles
note(60, p) / note("c3 e3") // pitch
transpose(12, p)            // relative pitch
sound("bd", p)              // instrument: bd sn hh oh cp tom sine saw square tri noise
gain/cutoff/res/pan/attack/decay/sustain/release/delay/speed/crush(v, p)
silence
```

Example:

```js
const drums = stack(
  "bd . hh bd . hh . hh",
  gain(0.55, fast(2, "sn . . sn")),
  gain(0.35, "hh*4")
);
const bass = note("c2 . . c2 . g1 . .").gain(0.75).cutoff(500);
stack(drums, bass).delay(0.3)
```

**ctrl+enter** = run (hot-swaps the pattern while playing),
**ctrl+.** = stop.

## Controls (the 12 IR slots)

`note gain cutoff pan attack decay sustain release delay resonance speed crush`

Unset slots ride along as `NaN` through the IR, become Rust defaults at pack
time (`60, 1, 12000, 0.5, 0.005, 0.05, 1, 0.05, 0, 0.1, 1, 0`), and are
clamped again in the DSP.

## Layout

```
crates/muse-core/   Rust: IR decoder, query engine, clock/scheduler, DSP → wasm32
web/src/            TypeScript: DSL, REPL, engine, UI
web/public/         muse_core.wasm (copied by scripts/build-wasm.sh)
scripts/            build-wasm.sh, e2e.mjs
```
