import { describe, expect, it } from "vitest";
import { parseMidi, type MidiEvent } from "midi-file";
import { loadCore } from "../../cli/core";
import { outputFormat } from "../../cli/export";
import { renderMidi } from "../src/midi";
import { note, p, silence, stack } from "../src/dsl";

function absolute(track: MidiEvent[]) {
  let tick = 0;
  return track.map((event) => { tick += event.deltaTime; return { ...event, tick }; });
}

describe("export formats", () => {
  it("infers extensions, accepts aliases and rejects mislabeled files", () => {
    expect(outputFormat(null, "song.MP3")).toBe("mp3");
    expect(outputFormat(null, "song.m4a")).toBe("m4a");
    expect(outputFormat("midi", null)).toBe("mid");
    expect(outputFormat(null, null)).toBe("wav");
    expect(() => outputFormat("mp3", "song.wav")).toThrow("does not match");
    expect(() => outputFormat(null, "song.exe")).toThrow("unsupported");
    expect(() => outputFormat("unknown", null)).toThrow("unsupported");
  });
  it("preserves melody, tempo, dynamics, rests and a clipped end", async () => {
    const core = await loadCore();
    const data = parseMidi(renderMidi(core, note("c4 ~ e4 g4").gain(0.5).pat, 0.4, 2));
    expect(data.header.format).toBe(1);
    expect(data.header.ticksPerBeat).toBe(480);
    const tempo = data.tracks[0].find((e) => e.type === "setTempo");
    expect(tempo?.type === "setTempo" && tempo.microsecondsPerBeat).toBe(500000);
    const track = absolute(data.tracks[1]);
    const ons = track.filter((e) => e.type === "noteOn");
    expect(ons.map((e) => [e.tick, e.type === "noteOn" && e.noteNumber])).toEqual([[0, 60], [240, 64], [360, 67]]);
    expect(ons.every((e) => e.type === "noteOn" && e.velocity === 64)).toBe(true);
    expect(track[track.length - 1].tick).toBe(384);
    expect(track.filter((e) => e.type === "noteOff").every((e) => e.tick <= 384)).toBe(true);
  });
  it("maps drum aliases to the percussion channel and GM notes", async () => {
    const core = await loadCore();
    const data = parseMidi(renderMidi(core, p("kick snare hh oh cp tom").pat, 1, 1));
    const ons = data.tracks[1].filter((e) => e.type === "noteOn");
    expect(ons.map((e) => e.type === "noteOn" && [e.channel, e.noteNumber])).toEqual([[9, 36], [9, 38], [9, 42], [9, 46], [9, 39], [9, 45]]);
  });
  it("exports silence, skips gain-zero notes and handles custom sample names", async () => {
    const core = await loadCore();
    const empty = parseMidi(renderMidi(core, stack(silence, note(60).gain(0)).pat, 1, 1));
    expect(empty.tracks).toHaveLength(1);
    const sampled = parseMidi(renderMidi(core, p("bd").pat, 1, 1, new Set(["bd"])));
    expect(sampled.tracks[1].some((e) => e.type === "noteOn" && e.channel !== 9 && e.noteNumber === 60)).toBe(true);
    const namedDrums = parseMidi(renderMidi(core, p("drums").pat, 1, 1));
    expect(namedDrums.tracks[1].some((e) => e.type === "noteOn" && e.noteNumber === 60)).toBe(true);
  });
  it("coalesces chorus unisons, applies speed to pitch and handles short repeated notes", async () => {
    const core = await loadCore();
    const data = parseMidi(renderMidi(core, note(60).chorus(0.01).pat, 1, 1));
    expect(data.tracks[1].filter((e) => e.type === "noteOn")).toHaveLength(1);
    const pitched = parseMidi(renderMidi(core, note(60).speed(2).pat, 1, 1));
    expect(pitched.tracks[1].some((e) => e.type === "noteOn" && e.noteNumber === 72)).toBe(true);
    const repeated = parseMidi(renderMidi(core, p("sine*4").pat, 1, 1));
    const events = absolute(repeated.tracks[1]);
    expect(events.filter((e) => e.type === "noteOn").map((e) => e.tick)).toEqual([0, 120, 240, 360]);
    expect(events.filter((e) => e.type === "noteOff").map((e) => e.tick)).toEqual([120, 240, 360, 480]);
  });
  it("rejects invalid duration and tempo", async () => {
    const core = await loadCore();
    expect(() => renderMidi(core, note(60).pat, NaN, 1)).toThrow();
    expect(() => renderMidi(core, note(60).pat, 1, 0)).toThrow();
  });
});
