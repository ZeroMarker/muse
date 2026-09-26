# muse

Live-coded music in the browser — a Strudel/Sonic-Pi-style DSL with a Rust
clock, scheduler, and audio engine. The same DSL also runs in a terminal and
renders audio offline.

## User guide

Read the **[Muse DSL 用户指南（中文）](docs/DSL_GUIDE.zh-CN.md)** for a hands-on
introduction to rhythms, melodies, instruments, effects, samples, and exports.
All JavaScript examples can be pasted into the Web UI.

## Web UI

Open **[muse.20070809.xyz](https://muse.20070809.xyz)** and sign in with the
existing `admin` account and site password. Caddy serves the production build
with HTTPS; the development server is not needed for the deployed site.

Click **Run** or press **Ctrl+Enter** to play the default **Canon in D** loop
at **90 bpm**. On macOS, **Cmd+Enter** also works. Click **Stop** or press
**Ctrl+.** / **Cmd+.** to stop. Audio starts only after a user action.

If a saved draft appears, choose **Canon in D** from the example menu. The
current code is backed up first, and **restore previous draft** swaps it back.
For deployment and updates, see [Caddy deployment](docs/DEPLOYMENT.md).

## Run locally

Install Node.js 22+, npm, and stable Rust with rustup. The build script installs
`wasm32-unknown-unknown` if it is missing.

```sh
npm ci
npm run dev          # builds WASM and starts http://localhost:5173
```

A local editor starts with the same Canon example. To preview a production
build locally:

```sh
npm run build
npm run preview      # Vite prints the preview URL
```

## Editor workflow

The default example is a looping arrangement of Pachelbel’s **Canon in D**,
with the eight-note ground bass, chord accompaniment, and three imitative
melody voices. The initial tempo is 90 bpm. Select **Canon in D** from the
example menu to load it over a saved draft. The unedited previous default
is migrated automatically; edited drafts are preserved. The source is
[examples/canon.js](examples/canon.js).

The editor saves your current code locally after each change and restores it on
reload. Selecting an example backs up the current draft; **restore previous
draft** swaps it back. A storage status appears in the toolbar. Examples do not
start playback until you press Run. Syntax and runtime errors show a Monaco
marker; errors with a source location reveal the corresponding line.

Choose **seconds** (1–300), select **format**, and click **download …** to
export the current editor code at the selected BPM. Audio export uses a separate
worker and the same deterministic Rust DSP as the CLI. All audio formats are
stereo at 48 kHz; the source render is 16-bit PCM. Export starts at cycle zero
and cuts release/delay tails at the selected length. Compressed formats can
contain small encoder padding.

| Format | Encoding | Use |
| --- | --- | --- |
| WAV | 16-bit PCM, uncompressed | Editing and compatibility |
| FLAC | Lossless compression of the PCM render | Smaller lossless files |
| MP3 | 192 kbps | Sharing and general playback |
| OGG | Vorbis, quality 5 | Vorbis players |
| AAC | 192 kbps, ADTS container (.aac) | Raw AAC audio |
| M4A | AAC at 192 kbps, MP4 container (.m4a) | AAC in a common music container |
| MIDI | Standard MIDI File type 1, 480 ticks per beat | Editable notes in a DAW |

The browser encodes locally and includes loaded samples in every audio format.
Selecting a compressed audio format loads the bundled encoder on demand; its
WASM asset is about 31 MiB before HTTP compression. It is served from the same
site, with no runtime CDN dependency. WAV and MIDI do not load this encoder.

MIDI exports timing, rounded semitone pitches (including speed), velocity,
tempo, and approximate General MIDI instruments. Drums use the percussion
channel. It does not embed sample files, filters, envelopes, panning, crush, or
audio delay. Pattern-level echo/chorus contribute notes, with simultaneous
unisons merged and overlapping repeated pitches retriggered. Up to 15 melodic
instruments and 100,000 notes are supported; custom samples are represented by
piano notes. The result's sound depends on the MIDI player.

To use your own audio, enter an instrument name such as `my_sample` and choose
an audio file under **load audio**. Browser-decodable audio up to 30 seconds and
50 MiB is supported; stereo is mixed to mono. Play it with:

```js
sound("my_sample", "x*4").gain(0.7)
```

Samples use MIDI 60 as their original pitch; `note(72, …)` or `.speed(2)` plays
an octave higher. Samples play once, use the normal envelope/filter/pan/effects,
and stop producing source audio at the end of their data; filters and delay
can continue to produce a tail. Samples remain available through
Stop and pattern changes and are included in browser exports. Reloading the
page requires loading them again; the CLI does not load sample files yet.
Sample names start with a letter and contain only ASCII letters, numbers, or
underscores (at most 127 characters). Choose a unique name: sample names
override built-in instruments with that name.

Additional instruments: `pulse` (25% duty cycle) and `organ` (three harmonics).
Additional effects, available as functions and chainable methods:

```js
note("c3 e3 g3").sound("organ").chorus(0.01)
// original plus three repeats, spaced a quarter cycle apart
note("c4 ~ e4 ~").sound("sine").echo(3, 0.25, 0.5)
```

`echo(repeats, cycles, feedback, pattern)` allows 0–8 repeats and feedback 0–1.
`chorus(depth, pattern)` layers dry and stereo detuned voices, depth 0–0.1.
Echo preserves the original layer gain and sets each repeat gain to a
successive power of feedback. Chorus uses 0.5 for dry and 0.25 for each detuned
layer. Assigned gains replace earlier gain settings on those layers. Chorus
also sets speed and pan on its detuned layers. Echo timing follows the live tempo.

### Included examples

| Example menu | Source | Description |
| --- | --- | --- |
| Canon in D | [canon.js](examples/canon.js) | Default looping arrangement: ground bass, chords, and three imitative voices |
| drums | [examples.ts](web/src/examples.ts) | Euclidean kick, hats, and snare |
| ambient | [ambient.js](examples/ambient.js) | Slow organ harmony and sine melody |
| pulse bass | [pulse.js](examples/pulse.js) | Pulse bass, Euclidean drums, and crushed hats |

The Canon melody spans 32 cycles; at 90 bpm a loop lasts about 21.3 seconds.
The three melody voices are offset by 8 cycles. This is a repeating arrangement,
not a full performance with a staged entrance or ending. The standalone ambient
and pulse files are variations on their corresponding toolbar examples.

## First pattern

Start with `"bd ~ sn ~"`, press Ctrl+Enter, then add hats:

```js
stack("bd ~ sn ~", gain(0.3, "hh*8"))
```

Add melody with `note("c3 e3 g3 b3").sound("organ")`, combine with `stack`,
and use `.slow(2)` for half speed. One cycle is one pass of the pattern; the BPM
control represents cycles per minute. Press Ctrl+. to stop. Try the toolbar's
drums, ambient, and pulse bass examples or render the files in `examples/`.

## CLI

The same pipeline ships as a self-contained terminal command (wasm inlined):

```sh
npm run build:cli            # → dist/cli/muse.cjs (single file, wasm included)
./muse                       # interactive REPL with a live timeline
./muse run examples/canon.js --bpm 90 --seconds 24 -o canon.wav
./muse run examples/demo.js --bpm 120 --seconds 8 -o demo.wav
./muse run examples/canon.js --bpm 90 --seconds 24 -o canon.mp3
./muse run examples/canon.js --bpm 90 --seconds 24 --format flac -o canon.flac
./muse run examples/canon.js --bpm 90 --seconds 24 --format midi -o canon.mid

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
- `muse run` renders PCM offline, then exports audio or MIDI
- commands: `:bpm [n]` `:play` `:stop` `:help` `:quit`

The Web UI starts at 90 bpm; the CLI defaults to 120 bpm, so pass `--bpm 90`
for the Canon example. `--seconds` defaults to 8; rendering accepts positive
lengths up to 300 seconds. Add `--no-play` to render without opening a player.
`./muse` builds the CLI on demand when the bundle is missing.

The CLI infers the format from the output extension or accepts `--format`
(`wav mp3 flac ogg aac m4a mid`; `midi` is an alias for `mid`). With neither
option it exports WAV. An explicit format must match the output extension.
Compressed audio exports require a system **FFmpeg** installation; WAV and MIDI
work without it. MIDI is saved without automatic playback.

Web builds replace `dist/`, including any earlier CLI bundle. After a web
build, use `./muse` or run `npm run build:cli` before invoking the bundle directly
or a globally linked `muse` command.

## Validation

The complete verification requires system `ffmpeg` and `ffprobe`, as well as
Chromium. On Ubuntu, install the codec tools, then the browser:

```sh
sudo apt-get install -y ffmpeg
npx playwright install --with-deps chromium
```

```sh
npm test             # Rust + TypeScript tests + wasm build
npm run cli:test     # CLI smoke test (help/run/repl, wav roundtrip)
npm run build        # production build → dist/
node scripts/e2e.mjs # headless-Chromium end-to-end test (needs `npm run build`)
npm run verify       # everything above, in order
```

GitHub Actions runs `npm run verify` for pushes to `main` and pull requests.
The checks cover Rust DSP/scheduling, TypeScript DSL and WASM boundaries,
audio initialization/retry, CLI rendering, and browser playback, draft recovery,
downloads for every export format, sample playback, and error locations.
Codec checks probe and decode actual files, including bit-exact FLAC roundtrips.

## The pipeline

```text
Monaco → JavaScript DSL / REPL → Pattern IR → Rust/WASM scheduler
                                             ↓
                                  AudioWorklet → Rust/WASM DSP
```

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
| Offline rendering | `web/src/offline.ts`, `web/src/audio/export-worker.ts`, `cli/wav.ts` | shared DSP renderer, audio codecs, and MIDI note export; browser export runs in a worker |
| Examples | `examples/canon.js`, `web/src/examples.ts` | shared default Canon source and toolbar examples |
| CLI | `cli/*.ts` → `dist/cli/muse.cjs` | wall-clock transport, PCM sink, ANSI timeline, offline audio/MIDI |

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

Functions (most transforms and controls also support chainable methods):

```js
stack(a, b)                 // parallel layers
cat(a, b)                   // sequence across one cycle
alt(a, b)                   // one per cycle
fast(k, p)  slow(k, p)      // time warp
rev(p)                      // mirror each cycle
every(4, q => q.fast(2), p)        // transform every n-th cycle
sometimes(0.5, rev, p)      // probabilistic transform
chunk(4, q => q.fast(2), p)        // cycle split in n slots, transform slot cycle%n
euclid(3, 8, p)             // x..x..x.
struct("x.x.x.", p)         // mask gates the pattern
shift(0.25, p)              // move in cycles
note(60, p) / note("c3 e3") // pitch
transpose(12, p)            // relative pitch
echo(3, 0.25, 0.5, p)       // cycle-synced repeats
chorus(0.01, p)             // stereo detune
sound("bd", p)              // instrument: bd sn hh oh cp tom sine saw square tri noise pulse organ
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
cli/                Terminal: driver, PCM sinks, TUI, offline audio/MIDI export
scripts/            build-wasm.sh, build-cli.sh, e2e.mjs, cli-test.mjs
examples/           Canon in D, ambient, pulse bass, and drum demo
docs/               Caddy deployment and release/rollback instructions
```

Browser codec dependencies and their source/license references are listed in
[third-party notices](THIRD_PARTY_NOTICES.md).
