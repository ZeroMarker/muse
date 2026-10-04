import { describe, expect, it } from "vitest";
import { parseArgs } from "../../cli/args";

describe("CLI arguments", () => {
  it("keeps defaults and accepts fractional durations and repeated samples", () => {
    expect(parseArgs([])).toMatchObject({ cmd: "repl", seconds: 8, bpm: 120 });
    expect(parseArgs(["run", "song.js", "--seconds", "0.5", "--bpm", "90", "--sample", "a=a.wav", "--sample", "b=b.wav"]))
      .toMatchObject({ cmd: "run", _: ["song.js"], seconds: 0.5, bpm: 90, samples: ["a=a.wav", "b=b.wav"] });
  });
  it.each(["0", "invalid", "NaN", "Infinity", "-1", ""])("rejects invalid numbers: %s", (value) => {
    for (const flag of ["--seconds", "--bpm"]) expect(() => parseArgs(["run", "song.js", flag, value])).toThrow();
  });
  it("rejects durations over 300 seconds, missing values and unknown options", () => {
    expect(() => parseArgs(["run", "song.js", "--seconds", "301"])).toThrow("at most 300");
    for (const flag of ["--seconds", "--bpm", "--out", "-o", "--format", "--sample"]) {
      expect(() => parseArgs(["run", "song.js", flag])).toThrow("needs a value");
      expect(() => parseArgs(["run", "song.js", flag, "--no-play"])).toThrow("needs a value");
    }
    expect(() => parseArgs(["run", "song.js", "--secnds", "1"])).toThrow("unknown option");
    expect(() => parseArgs(["rn", "song.js"])).toThrow("unknown command");
    expect(() => parseArgs(["run", "one.js", "two.js"])).toThrow("one pattern file");
  });
  it("supports option-like file names after --", () => {
    expect(parseArgs(["run", "--", "-song.js"])._).toEqual(["-song.js"]);
  });
});
