import { describe, expect, it } from "vitest";
import { Pattern, euclid, fast, note, stack, toPattern, transpose } from "../src/dsl";
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

  it("euclid(3,8) produces x..x..x. style masks", () => {
    const e = euclid(3, 8, "bd");
    expect(e.pat.t).toBe("struct");
    expect((e.pat as { mask: string }).mask).toBe("x..x..x.");
  });

  it("euclid supports rotation", () => {
    const e = euclid(3, 8, "bd", 1);
    expect((e.pat as { mask: string }).mask).toBe(".x..x..x");
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
