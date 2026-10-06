import { describe, expect, it } from "vitest";
import { evaluate } from "../src/repl";
import { echo, chorus, note, fast, stack } from "../src/dsl";
import { encodeWav, renderOffline } from "../src/offline";
import { unpackEvents, CTL } from "../src/ir";
import { validateSampleBudget } from "../src/samples";
import { renderMidi } from "../src/midi";
import { loadCore } from "../../cli/core";

describe("editor evaluation and exports", () => {
  it("locates syntax errors on the original line", () => {
    const result = evaluate('const drums = "bd";\nstack(drums, ) +');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.line).toBe(2);
  });
  it("locates runtime DSL errors", () => {
    const result = evaluate('const drums = "bd";\nnote("c3", drums)');
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.line).toBe(2); expect(result.column).toBeGreaterThan(0); }
  });
  it("preserves completion values in multi-statement programs", () => {
    expect(evaluate('const a = "bd";\nstack(a, "hh")').ok).toBe(true);
  });
  it("exports registered samples using the same DSP", async () => {
    const core = await loadCore();
    const data = new Float32Array(4800).fill(0.5);
    const samples = new Map([["my_sample", { data, rate: 48000 }]]);
    const pcm = renderOffline(core, note(60).sound("my_sample").pat, 0.2, 2, 48000, samples);
    expect(Math.abs(pcm[1000])).toBeGreaterThan(500);
    const wav = encodeWav(pcm, 48000, 2);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect(wav.length).toBe(44 + pcm.length * 2);
  });
  it("schedules tempo-synced repeats and stereo detuned voices", async () => {
    const core = await loadCore();
    const x = core.exports;
    const sched = x.sched_new(2);
    const buffer = core.allocBytes(65536);
    try {
      const pattern = core.decodePattern(echo(2, 0.25, 0.5, "bd").pat);
      try { x.sched_set_pattern(sched, pattern); } finally { core.releasePattern(pattern); }
      x.sched_reset(sched, 0);
      let written = x.sched_query(sched, 1, buffer.ptr, buffer.len);
      let events = unpackEvents(core.readBytes(buffer.ptr, written));
      expect(events.map((e) => e.onsetCycle)).toEqual([0, 0.25, 0.5]);
      expect(events.map((e) => e.ctl[CTL.gain])).toEqual([1, 0.5, 0.25]);
      const chorused = core.decodePattern(chorus(0.01, "bd").pat);
      try { x.sched_set_pattern(sched, chorused); } finally { core.releasePattern(chorused); }
      x.sched_reset(sched, 0);
      written = x.sched_query(sched, 1, buffer.ptr, buffer.len);
      events = unpackEvents(core.readBytes(buffer.ptr, written));
      expect(events).toHaveLength(3);
      expect(events.map((e) => e.ctl[CTL.pan]).sort()).toEqual([0, 0.5, 1]);
      expect(events.map((e) => e.ctl[CTL.speed]).sort()).toEqual([0.99, 1, 1.01]);
    } finally { core.free(buffer.ptr, buffer.len); x.sched_free(sched); }
  });
  it("rejects invalid rendering and effect parameters", async () => {
    const core = await loadCore();
    expect(() => renderOffline(core, note(60).pat, Infinity, 2)).toThrow();
    expect(() => echo(100, 0.25, 0.5, "bd")).toThrow();
    expect(() => chorus(NaN, "bd")).toThrow();
  });
});


describe("bounded audio exports", () => {
  it("rejects excessive queries in both audio and MIDI and remains usable", async () => {
    const core = await loadCore();
    const dense = fast(1e9, "bd").pat;
    expect(() => renderOffline(core, dense, 0.01, 1)).toThrow(/query work or event limit/);
    expect(() => renderMidi(core, dense, 1, 1)).toThrow(/query work or event limit/);
    expect(renderOffline(core, note(60).pat, 0.01, 1).length).toBe(960);
  });
  it("reports rendering progress and rejects audio voice overload", async () => {
    const core = await loadCore();
    const progress: number[] = [];
    renderOffline(core, note(60).pat, 0.02, 1, 48000, new Map(), (percent) => progress.push(percent));
    expect(progress.at(-1)).toBe(100);
    expect(progress.every((percent, i) => i === 0 || percent > progress[i - 1])).toBe(true);
    const crowded = stack(...Array.from({ length: 129 }, (_, i) => note(i).sound("sine")));
    expect(() => renderOffline(core, crowded.pat, 0.01, 1)).toThrow(/overloaded/);
  });
  it("bounds total sample PCM and accounts for replacements", () => {
    const sample = { data: new Float32Array(1024 * 1024), rate: 48000 };
    const samples = new Map(Array.from({ length: 32 }, (_, i) => [String(i), sample]));
    expect(() => validateSampleBudget(samples)).not.toThrow();
    expect(() => validateSampleBudget(samples, "extra", sample)).toThrow(/128 MiB/);
    expect(() => validateSampleBudget(samples, "0", sample)).not.toThrow();
  });
});
