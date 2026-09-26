import { writeMidi, type MidiEvent } from "midi-file";
import { CTL, type Pat, type SchedEvent, unpackEvents } from "./ir";
import type { WasmCore } from "./wasm";

const PPQ = 480;
const DRUMS: Record<string, number> = { bd: 36, kick: 36, sn: 38, snare: 38, hh: 42, hat: 42, hhc: 42, oh: 46, cp: 39, clap: 39, tom: 45 };
const PROGRAMS: Record<string, number> = { sine: 80, sin: 80, saw: 81, sawtooth: 81, square: 80, sq: 80, pulse: 80, tri: 80, triangle: 80, organ: 16, noise: 122, nz: 122 };
type TimedEvent = { tick: number; order: number; event: MidiEvent };
type Note = { start: number; end: number; pitch: number; velocity: number };

/** MIDI notes and General MIDI approximations; audio effects are not embedded. */
export function renderMidi(core: WasmCore, pat: Pat, seconds: number, cps: number, sampleNames: ReadonlySet<string> = new Set()): Uint8Array<ArrayBuffer> {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 300) throw new Error("duration must be positive and at most 300 seconds");
  if (!Number.isFinite(cps) || cps < 0.06 || cps > 100) throw new Error("MIDI tempo must be 3.6–6000 bpm");
  const endTick = Math.round(seconds * cps * PPQ);
  const groups = new Map<string, SchedEvent[]>();
  const x = core.exports;
  const sched = x.sched_new(cps);
  let buffer = core.allocBytes(65536);
  try {
    const handle = core.decodePattern(pat);
    try { if (!x.sched_set_pattern(sched, handle)) throw new Error("pattern rejected"); }
    finally { core.releasePattern(handle); }
    x.sched_reset(sched, 0);
    let total = 0;
    const endCycle = seconds * cps;
    for (let cursor = 0; cursor < endCycle; cursor += 1) {
      const horizon = Math.min(cursor + 1, endCycle);
      let written = x.sched_query(sched, horizon, buffer.ptr, buffer.len);
      while (written === -2) {
        if (buffer.len >= 32 * 1024 * 1024) throw new Error("MIDI pattern is too dense");
        const larger = core.allocBytes(buffer.len * 2);
        core.free(buffer.ptr, buffer.len);
        buffer = larger;
        written = x.sched_query(sched, horizon, buffer.ptr, buffer.len);
      }
      if (written < 0) throw new Error("MIDI scheduling failed");
      for (const ev of unpackEvents(core.readBytes(buffer.ptr, written))) {
        if (++total > 100000) throw new Error("MIDI export supports at most 100,000 notes");
        if (ev.ctl[CTL.gain] <= 0) continue;
        const key = !sampleNames.has(ev.sound) && DRUMS[ev.sound] !== undefined ? "drums" : "sound:" + ev.sound;
        const group = groups.get(key) ?? [];
        group.push(ev);
        groups.set(key, group);
      }
    }
  } finally { core.free(buffer.ptr, buffer.len); x.sched_free(sched); }
  const tempo: MidiEvent[] = [
    { deltaTime: 0, type: "trackName", text: "Muse" },
    { deltaTime: 0, type: "setTempo", microsecondsPerBeat: Math.round(1e6 / cps) },
    { deltaTime: endTick, type: "endOfTrack" },
  ];
  const tracks: MidiEvent[][] = [tempo];
  let melodicChannel = 0;
  for (const [key, evs] of groups) {
    const drum = key === "drums";
    const name = drum ? "drums" : key.slice(6);
    if (!drum && melodicChannel === 9) melodicChannel++;
    if (!drum && melodicChannel > 15) throw new Error("MIDI supports at most 15 melodic instruments");
    const channel = drum ? 9 : melodicChannel++;
    const timed: TimedEvent[] = [{ tick: 0, order: 0, event: { deltaTime: 0, type: "trackName", text: name } }];
    if (!drum) timed.push({ tick: 0, order: 0, event: { deltaTime: 0, type: "programChange", channel, programNumber: sampleNames.has(name) ? 0 : PROGRAMS[name] ?? 0 } });
    const notes = evs.map((ev): Note => {
      const start = Math.round(ev.onsetCycle * PPQ);
      const pitch = drum ? DRUMS[ev.sound] : Math.round(ev.ctl[CTL.note] + 12 * Math.log2(Math.max(0.01, Math.min(16, ev.ctl[CTL.speed]))));
      return { start, end: Math.min(endTick, Math.max(start + 1, Math.round((ev.onsetCycle + ev.durSec * cps) * PPQ))),
        pitch: Math.max(0, Math.min(127, pitch)), velocity: Math.max(1, Math.min(127, Math.round(ev.ctl[CTL.gain] * 127))) };
    }).filter((note) => note.start < endTick).sort((a, b) => a.pitch - b.pitch || a.start - b.start);
    // Coalesce simultaneous unisons; retrigger an overlapping repeated pitch.
    const merged: Note[] = [];
    for (const note of notes) {
      const previous = merged[merged.length - 1];
      if (previous && previous.pitch === note.pitch) {
        if (previous.start === note.start) {
          previous.end = Math.max(previous.end, note.end);
          previous.velocity = Math.max(previous.velocity, note.velocity);
          continue;
        }
        previous.end = Math.min(previous.end, note.start);
      }
      merged.push(note);
    }
    for (const note of merged) {
      timed.push({ tick: note.start, order: 2, event: { deltaTime: 0, type: "noteOn", channel, noteNumber: note.pitch, velocity: note.velocity } });
      timed.push({ tick: note.end, order: 1, event: { deltaTime: 0, type: "noteOff", channel, noteNumber: note.pitch, velocity: 0 } });
    }
    timed.sort((a, b) => a.tick - b.tick || a.order - b.order);
    let cursor = 0;
    const events = timed.map(({ tick, event }) => {
      const result = { ...event, deltaTime: tick - cursor };
      cursor = tick;
      return result;
    });
    events.push({ deltaTime: endTick - cursor, type: "endOfTrack" });
    tracks.push(events);
  }
  return new Uint8Array(writeMidi({ header: { format: 1, numTracks: tracks.length, ticksPerBeat: PPQ }, tracks }));
}
