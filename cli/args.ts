export interface Flags {
  cmd: "help" | "version" | "repl" | "run";
  _: string[];
  seconds: number;
  out: string | null;
  format: string | null;
  bpm: number;
  play: boolean | null;
  audio: boolean;
  samples: string[];
}

export function parseArgs(argv: string[]): Flags {
  const f: Flags = { cmd: "repl", _: [], seconds: 8, out: null, format: null,
    bpm: 120, play: null, audio: true, samples: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (): string => {
      const next = argv[++i];
      if (!next || next.startsWith("-")) throw new Error(`${a} needs a value`);
      return next;
    };
    const number = (maximum?: number): number => {
      const n = Number(value());
      if (!Number.isFinite(n) || n <= 0 || (maximum !== undefined && n > maximum)) {
        throw new Error(`${a} must be positive${maximum === undefined ? "" : ` and at most ${maximum}`}`);
      }
      return n;
    };
    if (a === "-h" || a === "--help") f.cmd = "help";
    else if (a === "-v" || a === "--version") f.cmd = "version";
    else if (a === "run" && f._.length === 0) f.cmd = "run";
    else if (a === "repl" && f._.length === 0) f.cmd = "repl";
    else if (a === "--seconds") f.seconds = number(300);
    else if (a === "-o" || a === "--out") f.out = value();
    else if (a === "--format") f.format = value();
    else if (a === "--sample") f.samples.push(value());
    else if (a === "--bpm") f.bpm = number();
    else if (a === "--no-play") f.play = false;
    else if (a === "--play") f.play = true;
    else if (a === "--no-audio") f.audio = false;
    else if (a === "--") { f._.push(...argv.slice(i + 1)); break; }
    else if (a.startsWith("-")) throw new Error(`unknown option: ${a}`);
    else f._.push(a);
  }
  if (f.cmd === "run" && f._.length > 1) throw new Error("run accepts one pattern file");
  if (f.cmd === "repl" && f._.length) throw new Error(`unknown command: ${f._[0]}`);
  return f;
}
