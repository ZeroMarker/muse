// muse CLI — terminal封装 of the same pipeline the browser uses:
// evaluate code → Pattern IR → wasm clock/scheduler → wasm DSP → PCM sink.

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { createInterface, emitKeypressEvents, type Interface } from "node:readline";

import { evaluate } from "../web/src/repl";
import { loadCore } from "./core";
import { Driver } from "./driver";
import { createSink, playFile } from "./sink";
import { TerminalViz } from "./tui";
import { SAMPLE_RATE, encodeWav, renderOffline, rms } from "./wav";

const VERSION = "0.1.0";
const PROMPT = "muse ❯ ";

const USAGE = `muse ${VERSION} — live music DSL for the terminal

  muse                      interactive REPL (same DSL as the browser)
  muse repl [--no-audio]    explicit REPL
  muse run <file> [opts]    render a pattern file to wav

  run options:
    --seconds <n>     length to render        (default 8)
    -o, --out <path>  output wav              (default <file>.wav)
    --bpm <n>         tempo                   (default 120)
    --no-play         don't play the result
    --play            play even when piped

REPL commands:
  :bpm [n]   show/set tempo      :play / :stop   transport
  :help      this help           :quit           exit (also ctrl+d)

Everything else is evaluated as code; the last expression is the pattern:
  stack("bd . hh .", "sn . . sn").delay(0.3)
`;

interface Flags {
  cmd: "help" | "version" | "repl" | "run";
  _: string[];
  seconds: number;
  out: string | null;
  bpm: number;
  play: boolean | null;
  audio: boolean;
}

function parseArgs(argv: string[]): Flags {
  const f: Flags = {
    cmd: "repl",
    _: [],
    seconds: 8,
    out: null,
    bpm: 120,
    play: null,
    audio: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") f.cmd = "help";
    else if (a === "-v" || a === "--version") f.cmd = "version";
    else if (a === "run") f.cmd = "run";
    else if (a === "repl") f.cmd = "repl";
    else if (a === "--seconds") f.seconds = Number(argv[++i]) || 8;
    else if (a === "-o" || a === "--out") f.out = argv[++i];
    else if (a === "--bpm") f.bpm = Number(argv[++i]) || 120;
    else if (a === "--no-play") f.play = false;
    else if (a === "--play") f.play = true;
    else if (a === "--no-audio") f.audio = false;
    else f._.push(a);
  }
  return f;
}

async function runCommand(f: Flags): Promise<number> {
  const file = f._[0];
  if (!file) {
    console.error("muse run: missing file (see --help)");
    return 2;
  }
  let code: string;
  try {
    code = readFileSync(file, "utf8");
  } catch {
    console.error(`muse run: cannot read ${file}`);
    return 2;
  }

  const res = evaluate(code);
  if (!res.ok) {
    console.error(`✗ ${res.error}`);
    return 1;
  }

  const core = await loadCore();
  const cps = f.bpm / 60;
  const pcm = renderOffline(core, res.pattern.pat, f.seconds, cps);
  const wav = encodeWav(pcm, SAMPLE_RATE, 2);
  const out = f.out ?? basename(file).replace(/\.[^.]*$/, "") + ".wav";
  writeFileSync(out, wav);

  let peak = 0;
  for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]) / 32768);
  console.log(
    `✓ ${out} — ${f.seconds}s @ ${f.bpm} bpm, ${(wav.length / 1024).toFixed(0)} KB, ` +
      `rms ${rms(pcm).toFixed(3)}, peak ${peak.toFixed(3)}`,
  );

  const wantPlay = f.play ?? Boolean(process.stdout.isTTY);
  if (wantPlay) {
    const child = playFile(out, (m) => console.error(`! ${m}`));
    if (child) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, (f.seconds + 5) * 1000);
        child.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    } else {
      console.error("! no player found (need ffplay)");
    }
  }
  return 0;
}

async function replCommand(f: Flags): Promise<number> {
  const core = await loadCore();
  const out = process.stdout;
  const isTty = Boolean(out.isTTY && process.stdin.isTTY);

  // logs may fire before the viz exists (sink probing) — buffer them
  let viz: TerminalViz | null = null;
  let rl: Interface | null = null;
  const buffered: string[] = [];

  const maybePrompt = (): void => {
    if (isTty && rl) out.write("\r" + PROMPT + rl.line);
  };
  const log = (line: string): void => {
    if (viz) viz.println(line);
    else buffered.push(line);
    maybePrompt();
  };
  const warn = (m: string): void => log(`! ${m}`);

  const sink = createSink(f.audio && isTty, warn);
  const driver = new Driver(core, sink, log);
  driver.setCps(f.bpm / 60);

  viz = new TerminalViz(
    () => {
      const state = driver.playing ? "▶" : "⏸";
      return `${state} ${Math.round(driver.cps * 60)} bpm · cycle ${driver.cycle().toFixed(2)} · sink ${sink.label}`;
    },
    (cycles) => driver.peek(cycles),
  );
  for (const line of buffered) viz.println(line);
  buffered.length = 0;

  rl = createInterface({
    input: process.stdin,
    output: out,
    prompt: PROMPT,
    terminal: isTty,
  });

  let lastKeyAt = 0;
  if (isTty) {
    emitKeypressEvents(process.stdin);
    process.stdin.on("keypress", () => {
      lastKeyAt = Date.now();
      viz?.clear();
      maybePrompt();
    });
    // redraw the timeline only while the user is idle
    const idleTimer = setInterval(() => {
      if (Date.now() - lastKeyAt > 350) viz?.redraw();
    }, 250);
    idleTimer.unref();
  }

  log(`muse ${VERSION} — ${sink.label}${f.audio ? "" : " (audio off)"}, ctrl+d to exit`);
  log(`try:  stack("bd . hh .", "sn . . sn")   then  :help`);

  const handle = (line: string): void => {
    const code = line.trim();
    if (!code) return;

    if (code.startsWith(":")) {
      const [cmd, arg] = code.slice(1).split(/\s+/);
      switch (cmd) {
        case "q":
        case "quit":
        case "exit":
          rl?.close();
          return;
        case "help":
          log("  :bpm [n]  tempo   :play  start   :stop  pause   :quit  exit");
          return;
        case "bpm": {
          if (arg) {
            const bpm = Math.min(300, Math.max(20, Number(arg) || 0));
            if (bpm) {
              driver.setCps(bpm / 60);
              log(`→ ${bpm} bpm`);
            } else {
              log("! :bpm needs a number");
            }
          } else {
            log(`→ ${Math.round(driver.cps * 60)} bpm`);
          }
          return;
        }
        case "play":
          driver.start();
          log("▶ playing");
          return;
        case "stop":
          driver.stop();
          log("⏸ stopped");
          return;
        default:
          log(`! unknown command :${cmd} — try :help`);
          return;
      }
    }

    const res = evaluate(code);
    if (!res.ok) {
      log(`✗ ${res.error}`);
      return;
    }
    try {
      driver.setPattern(res.pattern.pat);
      if (!driver.playing) driver.start();
      log(`✓ pattern installed in ${res.ms.toFixed(1)} ms · cycle ${driver.cycle().toFixed(2)}`);
    } catch (e) {
      log(`✗ ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const currentRl = rl;
  currentRl.on("line", (line) => {
    viz?.clear();
    handle(line);
    if (isTty) currentRl.prompt();
  });
  currentRl.on("close", () => {
    viz?.clear();
    viz?.stop();
    driver.dispose();
    sink.close();
    out.write("bye\n");
    process.exit(0);
  });
  currentRl.on("SIGINT", () => currentRl.close());

  if (isTty) currentRl.prompt();
  return new Promise<number>(() => {
    /* only resolved via rl close → process.exit */
  });
}

async function main(): Promise<void> {
  const f = parseArgs(process.argv.slice(2));
  if (f.cmd === "help") {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (f.cmd === "version") {
    process.stdout.write(VERSION + "\n");
    process.exit(0);
  }
  if (f.cmd === "run") {
    process.exit(await runCommand(f));
  }
  process.exit(await replCommand(f));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
