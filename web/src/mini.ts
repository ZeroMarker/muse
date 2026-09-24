// Mini-notation parser: Tidal/Strudel-flavoured strings → Pattern IR.
//
//   "bd [hh hh] <sn cp>"   sequence, groups, per-cycle alternation
//   "(a b)"                simultaneous (stack)
//   "bd*2"  "[a b]/2"      fast / slow postfix
//   "."  "~"               rests
//   "c3 e2 g4"             note names → pitched saw voices
//   "60 62 64"             bare numbers → midi notes

import { type Pat, atom, rest } from "./ir";

const NOTE_NAMES: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const NOTE_RE = /^([a-gA-G])([#b]?)(-?\d+)$/;

function tokenToPat(tok: string): Pat {
  if (tok === "." || tok === "~") return rest;

  const note = NOTE_RE.exec(tok);
  if (note) {
    const letter = note[1].toLowerCase();
    const acc = note[2];
    const octave = Number(note[3]);
    let midi = NOTE_NAMES[letter] + (octave + 1) * 12;
    if (acc === "#") midi += 1;
    else if (acc === "b") midi -= 1;
    return atom("saw", midi);
  }

  if (/^-?\d+(\.\d+)?$/.test(tok)) {
    return atom("saw", Number(tok));
  }

  return atom(tok);
}

const GROUP_START = new Set(["[", "(", "<"]);
const CLOSERS: Record<string, string> = { "[": "]", "(": ")", "<": ">" };
const TOKEN_STOP = new Set([
  " ", "\t", "\n", "\r", "[", "]", "(", ")", "<", ">", "*", "/", ".", "~",
]);

class Parser {
  pos = 0;
  constructor(readonly src: string) {}

  private skipWs() {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) this.pos++;
  }

  /** Parse items until `closer` (or end of input). */
  private seq(closer: string | null): Pat[] {
    const items: Pat[] = [];
    for (;;) {
      this.skipWs();
      if (this.pos >= this.src.length) {
        if (closer) throw new SyntaxError(`unclosed '${closer}' in mini-notation`);
        break;
      }
      const ch = this.src[this.pos];
      if (closer && ch === closer) {
        this.pos++;
        break;
      }
      if (ch === "." || ch === "~") {
        this.pos++;
        items.push(rest);
        continue;
      }
      if (GROUP_START.has(ch)) {
        this.pos++;
        items.push(this.group(ch));
        continue;
      }
      items.push(this.token());
    }
    return items;
  }

  private group(open: string): Pat {
    const kids = this.seq(CLOSERS[open]);
    let inner: Pat;
    if (kids.length === 0) inner = rest;
    else if (open === "(") inner = { t: "overlay", kids };
    else if (open === "<") inner = { t: "altern", kids };
    else inner = { t: "cat", kids };
    return this.postfix(inner);
  }

  private token(): Pat {
    const start = this.pos;
    while (this.pos < this.src.length && !TOKEN_STOP.has(this.src[this.pos])) this.pos++;
    const tok = this.src.slice(start, this.pos);
    if (tok === "") {
      // stray stop-char (e.g. a lone '*') — consume and ignore
      this.pos++;
      return rest;
    }
    return this.postfix(tokenToPat(tok));
  }

  /** `*n` = fast n, `/n` = slow n, applied to the item just parsed. */
  private postfix(p0: Pat): Pat {
    let p = p0;
    for (;;) {
      const ch = this.src[this.pos];
      if (ch !== "*" && ch !== "/") return p;
      const save = this.pos;
      this.pos++;
      const start = this.pos;
      while (this.pos < this.src.length && /[0-9.]/.test(this.src[this.pos])) this.pos++;
      const numStr = this.src.slice(start, this.pos);
      const num = Number(numStr);
      if (!numStr || !Number.isFinite(num) || num <= 0) {
        this.pos = save; // not a postfix after all
        return p;
      }
      p = { t: "fast", k: ch === "*" ? num : 1 / num, kid: p };
    }
  }

  parseTop(): Pat {
    const kids = this.seq(null);
    if (kids.length === 0) return rest;
    if (kids.length === 1) return kids[0];
    return { t: "cat", kids };
  }

  atEnd(): boolean {
    this.skipWs();
    return this.pos >= this.src.length;
  }
}

/** Parse a mini-notation string into a Pattern IR node. */
export function mini(src: string): Pat {
  const p = new Parser(src);
  const pat = p.parseTop();
  if (!p.atEnd()) {
    throw new SyntaxError(`unexpected input in mini-notation at: ${src.slice(p.pos)}`);
  }
  return pat;
}
