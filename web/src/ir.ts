// Pattern IR — TypeScript side of the wire format decoded by `crates/muse-core/src/ir.rs`.
//
// Keep the encoder below in sync with the Rust decoder:
//
//   magic "MUSE" | u32 version=1 | node
//   node: u8 tag + payload (see ir.rs header for the tag table)

export const NCTL = 12;

/** Control slot indices — must match `ir.rs`. */
export const CTL = {
  note: 0,
  gain: 1,
  cutoff: 2,
  pan: 3,
  attack: 4,
  decay: 5,
  sustain: 6,
  release: 7,
  delay: 8,
  resonance: 9,
  speed: 10,
  crush: 11,
} as const;

export type Ctl = (number | null)[]; // length NCTL, null = unset (NaN on the wire)

export type Pat =
  | { t: "rest" }
  | { t: "atom"; sound: string; ctl: Ctl }
  | { t: "cat"; kids: Pat[] }
  | { t: "overlay"; kids: Pat[] }
  | { t: "fast"; k: number; kid: Pat }
  | { t: "every"; n: number; step: Pat; kid: Pat }
  | { t: "sometimes"; p: number; step: Pat; kid: Pat }
  | { t: "rev"; kid: Pat }
  | { t: "altern"; kids: Pat[] }
  | { t: "struct"; mask: string; kid: Pat }
  | { t: "shift"; d: number; kid: Pat }
  | { t: "setctl"; slot: number; v: number; kid: Pat }
  | { t: "setsound"; sound: string; kid: Pat }
  | { t: "addctl"; slot: number; d: number; kid: Pat }
  | { t: "chunk"; n: number; step: Pat; kid: Pat };

export const rest: Pat = { t: "rest" };

export function emptyCtl(): Ctl {
  return new Array<number | null>(NCTL).fill(null);
}

export function atom(sound: string, note?: number): Pat {
  const ctl = emptyCtl();
  if (note !== undefined) ctl[CTL.note] = note;
  return { t: "atom", sound, ctl };
}

class Writer {
  private buf = new Uint8Array(4096);
  private len = 0;

  private ensure(n: number) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u8(v: number) {
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
  }

  u32(v: number) {
    this.ensure(4);
    new DataView(this.buf.buffer).setUint32(this.len, v >>> 0, true);
    this.len += 4;
  }

  u64(v: number) {
    this.ensure(8);
    new DataView(this.buf.buffer).setBigUint64(this.len, BigInt(Math.trunc(v)), true);
    this.len += 8;
  }

  f64(v: number) {
    this.ensure(8);
    new DataView(this.buf.buffer).setFloat64(this.len, v, true);
    this.len += 8;
  }

  str(s: string) {
    const bytes = new TextEncoder().encode(s);
    this.u32(bytes.length);
    this.ensure(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

const TAG = {
  rest: 0,
  atom: 1,
  cat: 2,
  overlay: 3,
  fast: 4,
  every: 6,
  rev: 7,
  altern: 8,
  struct: 9,
  setctl: 11,
  setsound: 12,
  shift: 13,
  sometimes: 14,
  addctl: 15,
  chunk: 16,
} as const;

function node(w: Writer, p: Pat): void {
  switch (p.t) {
    case "rest":
      w.u8(TAG.rest);
      return;
    case "atom": {
      w.u8(TAG.atom);
      w.str(p.sound);
      for (let i = 0; i < NCTL; i++) {
        const v = p.ctl[i];
        w.f64(v === null || v === undefined || Number.isNaN(v) ? NaN : v);
      }
      return;
    }
    case "cat":
      w.u8(TAG.cat);
      writeKids(w, p.kids);
      return;
    case "overlay":
      w.u8(TAG.overlay);
      writeKids(w, p.kids);
      return;
    case "fast":
      w.u8(TAG.fast);
      w.f64(p.k);
      node(w, p.kid);
      return;
    case "every":
      w.u8(TAG.every);
      w.u64(p.n);
      node(w, p.step);
      node(w, p.kid);
      return;
    case "sometimes":
      w.u8(TAG.sometimes);
      w.f64(p.p);
      node(w, p.step);
      node(w, p.kid);
      return;
    case "rev":
      w.u8(TAG.rev);
      node(w, p.kid);
      return;
    case "altern":
      w.u8(TAG.altern);
      writeKids(w, p.kids);
      return;
    case "struct":
      w.u8(TAG.struct);
      w.str(p.mask);
      node(w, p.kid);
      return;
    case "shift":
      w.u8(TAG.shift);
      w.f64(p.d);
      node(w, p.kid);
      return;
    case "setctl":
      w.u8(TAG.setctl);
      w.u8(p.slot);
      w.f64(p.v);
      node(w, p.kid);
      return;
    case "setsound":
      w.u8(TAG.setsound);
      w.str(p.sound);
      node(w, p.kid);
      return;
    case "addctl":
      w.u8(TAG.addctl);
      w.u8(p.slot);
      w.f64(p.d);
      node(w, p.kid);
      return;
    case "chunk":
      w.u8(TAG.chunk);
      w.u64(p.n);
      node(w, p.step);
      node(w, p.kid);
      return;
    default: {
      const never: never = p;
      throw new Error(`unknown pattern node: ${JSON.stringify(never)}`);
    }
  }
}

function writeKids(w: Writer, kids: Pat[]) {
  if (kids.length === 0 || kids.length > 1024) {
    throw new Error(`bad child count ${kids.length}`);
  }
  w.u32(kids.length);
  for (const k of kids) node(w, k);
}

/** Encode a pattern to the wasm-side IR buffer. */
export function encode(pat: Pat): Uint8Array {
  const w = new Writer();
  w.u8(0x4d);
  w.u8(0x55);
  w.u8(0x53);
  w.u8(0x45);
  w.u32(1);
  node(w, pat);
  return w.finish();
}

// ---------------------------------------------------------------------------
// Packed scheduler records (sched.rs `pack_range`)
// ---------------------------------------------------------------------------

export const EVENT_HEADER = 8 + 8 + 8 * NCTL; // onset f64, dur f64, ctl[12] f64

export interface SchedEvent {
  onsetCycle: number;
  durSec: number;
  ctl: Float64Array; // defaults already applied
  sound: string;
}

/** Parse packed event records written by `sched_query` / `sched_peek`. */
export function unpackEvents(buf: ArrayBuffer | Uint8Array): SchedEvent[] {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: SchedEvent[] = [];
  let i = 0;
  while (i + EVENT_HEADER + 2 <= bytes.length) {
    const onsetCycle = dv.getFloat64(i, true);
    const durSec = dv.getFloat64(i + 8, true);
    i += 16;
    const ctl = new Float64Array(NCTL);
    for (let s = 0; s < NCTL; s++) {
      ctl[s] = dv.getFloat64(i, true);
      i += 8;
    }
    const sl = dv.getUint16(i, true);
    i += 2;
    if (i + sl > bytes.length) break;
    const sound = new TextDecoder().decode(bytes.subarray(i, i + sl));
    i += sl;
    out.push({ onsetCycle, durSec, ctl, sound });
  }
  return out;
}
