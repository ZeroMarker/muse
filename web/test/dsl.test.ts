import { describe, expect, it } from "vitest";
import { Pattern, euclid, fast, slow, note, chunk, every, sometimes, shift, struct, rev, stack, toPattern, transpose } from "../src/dsl";
import type { Pat } from "../src/ir";

describe("dsl", () => {
  it("coerces strings, numbers and arrays", () => {
    expect(toPattern("bd hh").pat.t).toBe("cat");
    expect(toPattern(60).pat.t).toBe("atom");
    expect(toPattern(["bd", "hh"]).pat.t).toBe("cat");
    expect(toPattern([60, 62, 64]).pat.t).toBe("cat");
  });

  it("builds composable immutable patterns", () => {
    const p = stack("bd hh", fast(2, "sn"));
    expect(p).toBeInstanceOf(Pattern);
    expect(p.pat.t).toBe("overlay");
    const inner = (p.pat as { kids: Pat[] }).kids[1];
    expect(inner.t).toBe("fast");
  });

  it("rejects invalid time factors instead of silently changing their meaning", () => {
    for (const factor of [0, -1, NaN, Infinity]) {
      expect(() => fast(factor, "bd")).toThrow(/finite and positive/);
      expect(() => slow(factor, "bd")).toThrow(/finite and positive/);
    }
  });

  it("euclid(3,8) produces x..x..x. style masks", () => {
    const e = euclid(3, 8, "bd");
    expect(e.pat.t).toBe("struct");
    expect((e.pat as { mask: string }).mask).toBe("x..x..x.");
  });

  it("euclid supports rotation", () => {
    const e = euclid(3, 8, "bd", 1);
    expect((e.pat as { mask: string }).mask).toBe(".x..x..x");
  });

  it("wraps negative Euclidean rotation and saturates excess hits", () => {
    const mask = (rotation: number) => (euclid(3, 8, "bd", rotation).pat as { mask: string }).mask;
    expect(mask(-1)).toBe("..x..x.x");
    expect(mask(-1)).toBe(mask(7));
    expect(mask(-17)).toBe(mask(-1));
    expect((euclid(100, 8, "bd").pat as { mask: string }).mask).toBe("xxxxxxxx");
    expect((euclid(0, 8, "bd").pat as { mask: string }).mask).toBe("........");
  });

  it("rejects invalid rhythmic counts, masks, offsets and probabilities", () => {
    for (const value of [0, -1, 1.5, Infinity, NaN]) {
      expect(() => every(value, rev, "bd")).toThrow(/interval/);
      expect(() => chunk(value, rev, "bd")).toThrow(/count/);
      expect(() => euclid(3, value, "bd")).toThrow(/step count/);
    }
    expect(() => chunk(4097, rev, "bd")).toThrow();
    expect(() => euclid(-1, 8, "bd")).toThrow();
    expect(() => euclid(3, 8, "bd", 0.5)).toThrow();
    for (const value of [NaN, Infinity, -0.1, 1.1]) expect(() => sometimes(value, rev, "bd")).toThrow(/probability/);
    expect(() => shift(NaN, "bd")).toThrow(/finite/);
    for (const mask of ["", "x~x", "x".repeat(4097)]) expect(() => struct(mask, "bd")).toThrow(/mask/);
  });

  it("every carries its step transform", () => {
    const p = new Pattern({ t: "atom", sound: "bd", ctl: new Array(12).fill(null) }).every(4, (q) =>
      q.fast(2),
    );
    expect(p.pat.t).toBe("every");
    expect((p.pat as { step: Pat }).step.t).toBe("fast");
  });

  it("note(number, pat) sets the note slot; note(string) parses names", () => {
    const forced = note(72, "bd hh");
    expect(forced.pat.t).toBe("setctl");
    expect((forced.pat as { slot: number }).slot).toBe(0);
    expect((forced.pat as { v: number }).v).toBe(72);

    const names = note("c3 e3");
    expect(names.pat.t).toBe("cat");
  });

  it("transpose adds relative to current/default note", () => {
    const t = transpose(12, note("c3"));
    expect(t.pat.t).toBe("addctl");
  });

  it("chaining sugar methods mirrors the functional API", () => {
    const a = toPattern("bd hh").gain(0.5).cutoff(2000);
    expect(a.pat.t).toBe("setctl");
    expect((a.pat as { kid: Pat }).kid.t).toBe("setctl");
  });
});
