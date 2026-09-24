// Canvas visualizer: shows the next few cycles of scheduled events.

import type { SchedEvent } from "../ir";

const DRUMS = ["bd", "sn", "hh", "oh", "cp", "tom"];

function color(sound: string): string {
  if (sound === "bd") return "#ff6b6b";
  if (sound === "sn") return "#ffa94d";
  if (sound === "hh" || sound === "oh") return "#ffe066";
  if (sound === "cp") return "#d0bfff";
  if (sound === "tom") return "#ff8787";
  let h = 0;
  for (let i = 0; i < sound.length; i++) h = (h * 31 + sound.charCodeAt(i)) % 360;
  return `hsl(${h} 70% 65%)`;
}

export class Visualizer {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const c = canvas.getContext("2d");
    if (!c) throw new Error("no 2d context");
    this.ctx = c;
    this.resize();
    window.addEventListener("resize", () => this.resize());
    this.clear();
  }

  private resize(): void {
    this.dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.floor(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * this.dpr));
    this.clear();
  }

  clear(): void {
    const { ctx, canvas } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = "#0b0e14";
    ctx.fillRect(0, 0, canvas.width / this.dpr, canvas.height / this.dpr);
  }

  /**
   * @param evs  events with onset in [lo, hi) cycles
   * @param lo   first visible cycle
   * @param hi   last visible cycle
   * @param pos  current cycle position
   * @param cps  cycles per second (durSec → cycles)
   */
  draw(evs: SchedEvent[], lo: number, hi: number, pos: number, cps: number): void {
    const { ctx, canvas } = this;
    const W = canvas.width / this.dpr;
    const H = canvas.height / this.dpr;
    const span = Math.max(1e-6, hi - lo);
    const x = (cycle: number) => ((cycle - lo) / span) * W;

    ctx.fillStyle = "#0b0e14";
    ctx.fillRect(0, 0, W, H);

    // cycle grid
    ctx.strokeStyle = "#1c2230";
    ctx.lineWidth = 1;
    for (let c = Math.ceil(lo); c <= hi; c += 1) {
      ctx.beginPath();
      ctx.moveTo(Math.round(x(c)) + 0.5, 0);
      ctx.lineTo(Math.round(x(c)) + 0.5, H);
      ctx.stroke();
      // eighth subdivisions
      ctx.strokeStyle = "#131824";
      for (let k = 1; k < 8; k++) {
        const gx = Math.round(x(c + k / 8)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(gx, H * 0.75);
        ctx.lineTo(gx, H);
        ctx.stroke();
      }
      ctx.strokeStyle = "#1c2230";
      ctx.fillStyle = "#3a4356";
      ctx.font = "10px monospace";
      ctx.fillText(String(c), Math.round(x(c)) + 4, 11);
    }

    const laneH = Math.min(16, (H - 16) / DRUMS.length);
    const pitchedTop = 14 + laneH * DRUMS.length + 4;

    for (const ev of evs) {
      const durCycles = Math.max(ev.durSec * cps, 0.02);
      const ex = x(ev.onsetCycle);
      const ew = Math.max(2, x(ev.onsetCycle + durCycles) - ex);
      if (ex > W || ex + ew < 0) continue;

      const isDrum = DRUMS.includes(ev.sound);
      let ey: number;
      let eh: number;
      if (isDrum) {
        ey = 14 + DRUMS.indexOf(ev.sound) * laneH;
        eh = laneH - 3;
      } else {
        const midi = ev.ctl[0];
        const t = 1 - Math.min(1, Math.max(0, (midi - 24) / 72));
        ey = pitchedTop + t * Math.max(8, H - pitchedTop - 12);
        eh = 8;
      }

      ctx.fillStyle = color(ev.sound);
      ctx.globalAlpha = 0.85;
      roundRect(ctx, ex, ey, ew, eh, 3);
      ctx.fill();
      ctx.globalAlpha = 1;

      if (ew > 34) {
        ctx.fillStyle = "#0b0e14";
        ctx.font = "10px monospace";
        ctx.fillText(ev.sound, ex + 4, ey + eh - 1);
      }
    }

    // playhead
    const px = x(pos);
    if (px >= 0 && px <= W) {
      ctx.strokeStyle = "#4ade80";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, H);
      ctx.stroke();
    }
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
