// Terminal visualizer: a compact ANSI timeline of upcoming events.
//
//   muse ❯ stack("bd . hh .", "sn . . sn")
//   ✓ pattern installed · 120 bpm · cycle 3.42
//   ┌ bd  ● · · · ● · · · ● · · · ● · · ·
//   │ sn  · · ○ · · · ○ · · · ○ · · · ○ ·
//   └ mel █ · █ · █ · █ · █ · █ · █ · █ ·

import type { SchedEvent } from "../web/src/ir";

const CYCLES = 4;
const SLOTS = CYCLES * 8; // eighth-note grid
const DRUM_ORDER = ["bd", "sn", "hh", "oh", "cp", "tom"];

function glyph(sound: string): string {
  switch (sound) {
    case "bd":
      return "●";
    case "sn":
      return "○";
    case "hh":
    case "oh":
      return "·";
    case "cp":
      return "◈";
    case "tom":
      return "◦";
    default:
      return "█";
  }
}

export class TerminalViz {
  private drawnLines = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly status: () => string,
    private readonly peek: (cycles: number) => SchedEvent[],
  ) {}

  get tty(): boolean {
    return Boolean(process.stdout.isTTY);
  }

  start(intervalMs = 200): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.redraw(), intervalMs);
    this.redraw();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Print a line above (or instead of) the visualization. */
  println(line: string): void {
    this.clear();
    process.stdout.write(line + "\n");
    this.drawnLines = 0;
  }

  /** Erase the drawn block (cursor returns to its start). */
  clear(): void {
    if (!this.tty || this.drawnLines === 0) return;
    let out = `\x1b[${this.drawnLines - 1}A`;
    for (let i = 0; i < this.drawnLines; i++) {
      out += "\x1b[2K";
      if (i < this.drawnLines - 1) out += "\n";
    }
    process.stdout.write(out);
    this.drawnLines = 0;
  }

  redraw(): void {
    if (!this.tty) return;
    const lines = this.render();
    let out = "";
    if (this.drawnLines > 0) out += `\x1b[${this.drawnLines - 1}A`;
    for (let i = 0; i < lines.length; i++) {
      out += "\r\x1b[2K" + lines[i];
      if (i < lines.length - 1 || this.drawnLines > i) out += "\n";
    }
    // trim leftovers from a longer previous block
    if (this.drawnLines > lines.length) {
      for (let i = lines.length; i < this.drawnLines; i++) out += "\r\x1b[2K" + (i < this.drawnLines - 1 ? "\n" : "");
    }
    process.stdout.write(out);
    this.drawnLines = lines.length;
  }

  private render(): string[] {
    const evs = this.peek(CYCLES);

    // lanes: drums by name, everything else collapses to "mel"
    const lanes = new Map<string, string[]>();
    for (const d of DRUM_ORDER) lanes.set(d, new Array(SLOTS).fill("·"));
    lanes.set("mel", new Array(SLOTS).fill("·"));

    for (const ev of evs) {
      const slot = Math.floor(ev.onsetCycle * 8);
      if (slot < 0 || slot >= SLOTS) continue;
      const lane = DRUM_ORDER.includes(ev.sound) ? ev.sound : "mel";
      const row = lanes.get(lane)!;
      if (row[slot] === "·" || lane === "mel") row[slot] = glyph(ev.sound);
    }

    const rows: string[] = [];
    const used = DRUM_ORDER.filter((d) => lanes.get(d)!.some((c) => c !== "·"));
    for (const d of used) {
      rows.push(`│ ${d.padEnd(4).slice(0, 4)}  ${lanes.get(d)!.join("")}`);
    }
    const mel = lanes.get("mel")!;
    if (mel.some((c) => c !== "·")) {
      rows.push(`└ mel  ${mel.join("")}`);
    }

    return [this.status(), ...rows];
  }
}
