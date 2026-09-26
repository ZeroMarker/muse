// PCM sinks: stream interleaved s16le to whatever the machine can play.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";

export interface Sink {
  readonly label: string;
  readonly alive: boolean;
  write(samples: Int16Array): void;
  close(): void;
}

const SR = 48000;
/** Drop samples once the pipe has ~0.75 s queued (keeps memory bounded). */
const MAX_QUEUED = SR * 2 * 2 * 3 / 4;

function nullSink(label: string): Sink {
  return {
    label,
    alive: true,
    write: () => undefined,
    close: () => undefined,
  };
}

function has(cmd: string, args: string[]): boolean {
  try {
    return spawnSync(cmd, args, { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Pick the first working player. When `audio` is false (or no player exists)
 * a silent sink is returned — the transport and TUI keep running.
 */
export function createSink(audio: boolean, onWarn: (msg: string) => void): Sink {
  if (!audio) return nullSink("audio off");

  type Spec = { label: string; cmd: string; args: string[] };
  const specs: Spec[] = [];
  if (has("ffplay", ["-version"])) {
    specs.push({
      label: "ffplay",
      cmd: "ffplay",
      args: ["-loglevel", "error", "-autoexit", "-nodisp", "-f", "s16le", "-ar", String(SR), "-ac", "2", "-i", "pipe:0"],
    });
  }
  if (has("paplay", ["--version"])) {
    specs.push({
      label: "paplay",
      cmd: "paplay",
      args: ["--raw", `--rate=${SR}`, "--format=s16le", "--channels=2"],
    });
  }
  if (has("aplay", ["--version"])) {
    specs.push({
      label: "aplay",
      cmd: "aplay",
      args: ["-q", "-f", "S16_LE", "-r", String(SR), "-c", "2", "-t", "raw"],
    });
  }

  for (const spec of specs) {
    const sink = tryStream(spec, onWarn);
    if (sink) return sink;
  }
  onWarn("no audio player/device — running silently (ffmpeg/aplay/paplay not usable)");
  return nullSink("silent");
}

function tryStream(spec: { label: string; cmd: string; args: string[] }, onWarn: (m: string) => void): Sink | null {
  let child: ChildProcess;
  try {
    child = spawn(spec.cmd, spec.args, { stdio: ["pipe", "ignore", "ignore"] });
  } catch {
    return null;
  }
  const stdin = child.stdin!;
  let dead = false;
  stdin.on("error", () => (dead = true));
  child.on("exit", () => {
    if (!dead) {
      dead = true;
      onWarn(`${spec.label} exited — audio off (headless machine?)`);
    }
  });

  return {
    label: spec.label,
    get alive() {
      return !dead && !stdin.destroyed && stdin.writable;
    },
    write(samples: Int16Array) {
      if (!this.alive) return;
      // bounded queue: if the pipe is backed up, drop rather than balloon
      if (stdin.writableLength > MAX_QUEUED) return;
      const buf = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
      try {
        stdin.write(buf);
      } catch {
        dead = true;
      }
    },
    close() {
      if (!stdin.destroyed) {
        try {
          stdin.end();
        } catch {
          /* ignore */
        }
      }
    },
  };
}

/** Play a finished audio file once (used by `muse run --play`).
 *  Returns the child process, or null when no player exists. */
export function playFile(path: string, onWarn: (m: string) => void): ChildProcess | null {
  if (has("ffplay", ["-version"])) {
    const child = spawn("ffplay", ["-loglevel", "error", "-autoexit", "-nodisp", path], {
      stdio: "ignore",
    });
    child.on("error", () => onWarn("ffplay failed"));
    return child;
  }
  return null;
}
