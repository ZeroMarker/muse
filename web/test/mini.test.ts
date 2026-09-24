import { describe, expect, it } from "vitest";
import { mini } from "../src/mini";
import type { Pat } from "../src/ir";

const as = <T extends Pat["t"]>(p: Pat, t: T): Extract<Pat, { t: T }> => {
  expect(p.t).toBe(t);
  return p as Extract<Pat, { t: T }>;
};

describe("mini-notation", () => {
  it("parses a bare token as a single atom", () => {
    const p = as(mini("bd"), "atom");
    expect(p.sound).toBe("bd");
  });

  it("splits space-separated tokens into a sequence", () => {
    const p = as(mini("bd hh sn"), "cat");
    expect(p.kids).toHaveLength(3);
    expect(p.kids.map((k) => (k as { sound: string }).sound)).toEqual(["bd", "hh", "sn"]);
  });

  it("parses brackets as sequence groups", () => {
    const p = as(mini("bd [hh hh] sn"), "cat");
    expect(p.kids).toHaveLength(3);
    const group = as(p.kids[1], "cat");
    expect(group.kids).toHaveLength(2);
  });

  it("parses parens as simultaneity", () => {
    const p = as(mini("(bd sn)"), "overlay");
    expect(p.kids).toHaveLength(2);
  });

  it("parses angle brackets as alternation", () => {
    const p = as(mini("<bd sn>"), "altern");
    expect(p.kids).toHaveLength(2);
  });

  it("handles rests (. and ~)", () => {
    const p = as(mini("bd . sn ~"), "cat");
    expect(p.kids.map((k) => k.t)).toEqual(["atom", "rest", "atom", "rest"]);
  });

  it("applies *n fast postfix to tokens", () => {
    const p = as(mini("bd*2"), "fast");
    expect(p.k).toBe(2);
    expect(as(p.kid, "atom").sound).toBe("bd");
  });

  it("applies /n slow postfix", () => {
    const p = as(mini("hh/4"), "fast");
    expect(p.k).toBe(0.25);
  });

  it("applies postfix to groups", () => {
    const p = as(mini("[bd sn]/2"), "fast");
    expect(p.k).toBe(0.5);
    expect(as(p.kid, "cat").kids).toHaveLength(2);
  });

  it("chains postfixes", () => {
    const p = as(mini("bd*2*3"), "fast");
    expect(p.k).toBe(3);
    expect(as(p.kid, "fast").k).toBe(2);
  });

  it("turns note names into pitched atoms", () => {
    const p = as(mini("c4"), "atom");
    expect(p.sound).toBe("saw");
    expect(p.ctl[0]).toBe(60);
    expect(as(mini("a4"), "atom").ctl[0]).toBe(69);
    expect(as(mini("eb3"), "atom").ctl[0]).toBe(51);
    expect(as(mini("c#5"), "atom").ctl[0]).toBe(73);
  });

  it("turns bare numbers into midi atoms", () => {
    const p = as(mini("60 62"), "cat");
    expect((p.kids[0] as { ctl: (number | null)[] }).ctl[0]).toBe(60);
  });

  it("recurses into nested groups", () => {
    const p = as(mini("bd [sn (hh oh)]"), "cat");
    const g = as(p.kids[1], "cat");
    expect(as(g.kids[1], "overlay").kids).toHaveLength(2);
  });

  it("throws on unclosed groups", () => {
    expect(() => mini("bd [hh sn")).toThrow(/unclosed/);
  });

  it("treats empty input as silence", () => {
    expect(mini("").t).toBe("rest");
    expect(mini("   ").t).toBe("rest");
  });
});
