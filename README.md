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

### CLI

The same pipeline ships as a self-contained terminal command (wasm inlined):

```sh
npm run build:cli            # → dist/cli/muse.cjs (single file, wasm included)
./muse                       # interactive REPL with a live timeline
./muse run examples/demo.js --bpm 120 --seconds 8 -o demo.wav

# or via npm / global install
npm run cli -- --help
npm link && muse             # puts `muse` on your PATH
```

```text
muse ❯ stack("bd . hh bd . hh . hh", fast(2, "sn . . sn"))
✓ pattern installed in 0.9 ms
▶ 120 bpm · cycle 3.42 · sink ffplay
│ bd   ● · · · ● · · ● · · · ● · · ●
│ sn   · ○ · · ○ · · ○ · · ○ · · ○ ·
└ mel  █ · █ · █ · █ · █ · █ · █ · █
```

- audio streams to `ffplay`/`paplay`/`aplay` when a device exists; otherwise it
  runs silently with the timeline (headless-friendly)
- `muse run` renders **offline & deterministically** to 16-bit WAV
- commands: `:bpm [n]` `:play` `:stop` `:help` `:quit`

```sh
npm test             # Rust + TypeScript tests + wasm build
npm run cli:test     # CLI smoke test (help/run/repl, wav roundtrip)
npm run build        # production build → dist/
node scripts/e2e.mjs # headless-Chromium end-to-end test (needs `npm run build`)
npm run verify       # everything above, in order
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
| CLI | `cli/*.ts` → `dist/cli/muse.cjs` | wall-clock transport, PCM sink, ANSI timeline, offline WAV |

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
cli/                Terminal封装: driver, PCM sinks, TUI, offline renderer
scripts/            build-wasm.sh, build-cli.sh, e2e.mjs, cli-test.mjs
examples/           pattern files for `muse run`
```

## Editor workflow

The editor saves your current code locally after each change and restores it on
reload. Selecting an example backs up the current draft; **restore previous
draft** swaps it back. A storage status appears in the toolbar. Examples do not
start playback until you press Run. Syntax and runtime errors show a Monaco
marker; errors with a source location reveal the corresponding line.

Choose **seconds** (1–300) and **download WAV** to render the current editor code
at the selected BPM. Export uses a separate worker and the same deterministic
Rust DSP as the CLI, so playback and editing stay responsive during rendering.
The download is stereo, 48 kHz, 16-bit PCM. Export starts at cycle zero and has
exactly the selected length; release/delay tails beyond that length are cut.

To use your own audio, enter an instrument name such as `my_sample` and choose
an audio file under **load audio**. Browser-decodable audio up to 30 seconds and
50 MiB is supported; stereo is mixed to mono. Play it with:

```js
sound("my_sample", "x*4").gain(0.7)
```

Samples use MIDI 60 as their original pitch; `note(72, …)` or `.speed(2)` plays
an octave higher. Samples play once, use the normal envelope/filter/pan/effects,
and become silent at the end of their data. Samples remain available through
Stop and pattern changes and are included in browser exports. Reloading the
page requires loading them again; the CLI does not load sample files yet.
Choose a unique name: sample names override built-in instruments with that name.

Additional instruments: `pulse` (25% duty cycle) and `organ` (three harmonics).
Additional effects, available as functions and chainable methods:

```js
note("c3 e3 g3").sound("organ").chorus(0.01)
// original plus three repeats, spaced a quarter cycle apart
note("c4 ~ e4 ~").sound("sine").echo(3, 0.25, 0.5)
```

`echo(repeats, cycles, feedback, pattern)` allows 0–8 repeats and feedback 0–1.
`chorus(depth, pattern)` layers dry and stereo detuned voices, depth 0–0.1.
These effects assign layer gains: echo uses 1 and successive powers of
feedback; chorus uses 0.5 for dry and 0.25 for each detuned layer. These
assignments replace earlier gain settings on those layers. Chorus also sets
speed and pan on its detuned layers. Echo timing follows the live tempo.

## Development prerequisites

Install Node.js 22+, npm, and stable Rust with rustup. The build script installs
`wasm32-unknown-unknown` if needed. For browser checks, install Chromium once:

```sh
npm ci
npx playwright install --with-deps chromium
npm run verify
```

GitHub Actions runs the same complete verification for pushes to `main` and
pull requests. CLI realtime playback optionally uses `ffplay`, `paplay`, or
`aplay`; offline rendering needs no audio device.

## First pattern

Start with `"bd ~ sn ~"`, press Ctrl+Enter, then add hats:

```js
stack("bd ~ sn ~", gain(0.3, "hh*8"))
```

Add melody with `note("c3 e3 g3 b3").sound("organ")`, combine with `stack`,
and use `.slow(2)` for half speed. One cycle is one pass of the pattern; the BPM
control represents cycles per minute. Press Ctrl+. to stop. Try the toolbar's
drums, ambient, and pulse bass examples or render the files in `examples/`.
