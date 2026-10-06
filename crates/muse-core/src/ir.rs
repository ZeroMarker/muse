//! Pattern IR: the data structure that crosses the WASM boundary, plus its
//! binary decoder. The encoder lives in `web/src/ir.ts` — the two must agree
//! on the wire format:
//!
//! ```text
//! magic  "MUSE"            4 bytes
//! version u32 LE           1
//! node:
//!   tag  u8
//!   0 Rest                                   —
//!   1 Atom   u32 len, utf8, f64[12] ctl      (NaN = unset)
//!   2 Cat    u32 n, node*n                   sequence (mini-notation `a b`, `[..]`)
//!   3 Overlay u32 n, node*n                  stack    (mini-notation `(..)`)
//!   4 Fast   f64 k, node                     k>1 faster, k<1 slower
//!   5 Slow   f64 k, node                     sugar, decoded as Fast(1/k)
//!   6 Every  i64 n, node step, node child
//!   7 Rev    node
//!   8 Altern u32 n, node*n                   mini-notation `<a b>`
//!   9 Struct u32 mlen, mask utf8, node child ('x' hit / '.' rest)
//!  10 Chunk  i64 n, i64 idx, node child
//!  11 SetCtl u8 slot, f64 v, node child
//!  12 SetSound u32 len, utf8, node child
//!  13 Shift  f64 cycles, node child
//!  14 Sometimes f64 prob, node step, node child
//!  15 AddCtl  u8 slot, f64 delta, node child    (transpose-style, NaN -> default)
//!  16 Chunk   u64 n, node step, node child      (cycle split into n slots,
//!                                                 slot `cycle % n` gets `step`)
//!  17 WithNote node pitches, node child         (sample pitch at child onset)
//! ```

/// Number of control slots carried by every event.
pub const NCTL: usize = 12;

pub const CTL_NOTE: usize = 0;
pub const CTL_GAIN: usize = 1;
pub const CTL_CUTOFF: usize = 2;
pub const CTL_PAN: usize = 3;
pub const CTL_ATTACK: usize = 4;
pub const CTL_DECAY: usize = 5;
pub const CTL_SUSTAIN: usize = 6;
pub const CTL_RELEASE: usize = 7;
pub const CTL_DELAY: usize = 8;
pub const CTL_RESONANCE: usize = 9;
pub const CTL_SPEED: usize = 10;
pub const CTL_CRUSH: usize = 11;

/// Defaults applied to `NaN` slots when an event is packed for playback.
pub const DEFAULTS: [f64; NCTL] = [
    60.0,    // note (midi)
    1.0,     // gain
    12000.0, // cutoff Hz
    0.5,     // pan
    0.005,   // attack
    0.05,    // decay
    1.0,     // sustain
    0.05,    // release
    0.0,     // delay send
    0.1,     // resonance
    1.0,     // speed
    0.0,     // crush
];

#[derive(Clone, Debug)]
pub enum Pat {
    /// Sample pitches at child onsets, preserving child timing and controls.
    WithNote(Box<Pat>, Box<Pat>),
    /// No events.
    Rest,
    /// One event per cycle, occupying the whole cycle in its own frame.
    Atom {
        sound: String,
        ctl: [f64; NCTL],
    },
    /// Divide the cycle evenly among children (`a b`, `[a b]`).
    Cat(Vec<Pat>),
    /// All children in parallel (`(a b)`).
    Overlay(Vec<Pat>),
    /// Time scale: output time = input time / k.
    Fast(f64, Box<Pat>),
    /// Apply `step` on cycles where `cycle % n == 0`, base pattern otherwise.
    Every(i64, Box<Pat>, Box<Pat>),
    /// Apply `step` on cycles passing a deterministic probability test.
    Sometimes(f64, Box<Pat>, Box<Pat>),
    /// Mirror each cycle.
    Rev(Box<Pat>),
    /// One child per cycle (`<a b>`).
    Altern(Vec<Pat>),
    /// Intersect the child with a hit/rest mask (euclid, struct, chunk..).
    Struct {
        mask: Vec<bool>,
        child: Box<Pat>,
    },
    /// Offset in cycles.
    Shift(f64, Box<Pat>),
    /// Force a control slot on all descendant events (wins over atom values).
    SetCtl(usize, f64, Box<Pat>),
    /// Force the sound on all descendant events.
    SetSound(String, Box<Pat>),
    /// Add `delta` to a control slot (NaN treated as the default first).
    AddCtl(usize, f64, Box<Pat>),
    /// Divide each cycle into `n` slots; apply `step` to slot `cycle % n`.
    Chunk(i64, Box<Pat>, Box<Pat>),
}

struct Reader<'a> {
    b: &'a [u8],
    i: usize,
    nodes: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        if self.i + n > self.b.len() {
            return Err(format!("unexpected end of IR at byte {}", self.i));
        }
        let s = &self.b[self.i..self.i + n];
        self.i += n;
        Ok(s)
    }

    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }

    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn u64(&mut self) -> Result<u64, String> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }

    fn f64(&mut self) -> Result<f64, String> {
        Ok(f64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }

    fn str(&mut self) -> Result<String, String> {
        let n = self.u32()? as usize;
        if n > 4096 {
            return Err("string too long".into());
        }
        String::from_utf8(self.take(n)?.to_vec()).map_err(|_| "invalid utf8".into())
    }
}

fn node(r: &mut Reader, depth: usize) -> Result<Pat, String> {
    r.nodes += 1;
    if r.nodes > 16_384 { return Err("pattern has too many nodes".into()); }
    if depth > 64 {
        return Err("pattern nesting too deep".into());
    }
    let tag = r.u8()?;
    match tag {
        0 => Ok(Pat::Rest),
        1 => {
            let sound = r.str()?;
            if sound.len() > 127 || !sound.is_ascii() { return Err("bad instrument name".into()); }
            let mut ctl = [f64::NAN; NCTL];
            for c in ctl.iter_mut() {
                *c = r.f64()?;
            }
            Ok(Pat::Atom { sound, ctl })
        }
        2 => Ok(Pat::Cat(children(r, depth)?)),
        3 => Ok(Pat::Overlay(children(r, depth)?)),
        4 => {
            let k = r.f64()?;
            if !k.is_finite() || k <= 0.0 { return Err("bad fast factor".into()); }
            Ok(Pat::Fast(k, Box::new(node(r, depth + 1)?)))
        }
        5 => {
            let k = r.f64()?;
            if !k.is_finite() || k <= 0.0 || !(1.0 / k).is_finite() { return Err("bad slow factor".into()); }
            let inner = node(r, depth + 1)?;
            Ok(Pat::Fast(1.0 / k, Box::new(inner)))
        }
        6 => {
            let n = r.u64()? as i64;
            if n <= 0 || n > 9_007_199_254_740_991 { return Err("bad every interval".into()); }
            let step = Box::new(node(r, depth + 1)?);
            let child = Box::new(node(r, depth + 1)?);
            Ok(Pat::Every(n.max(1), step, child))
        }
        7 => Ok(Pat::Rev(Box::new(node(r, depth + 1)?))),
        8 => Ok(Pat::Altern(children(r, depth)?)),
        9 => {
            let mask_str = r.str()?;
            if mask_str.is_empty() || mask_str.len() > 4096 || !mask_str.bytes().all(|c| c == b'x' || c == b'.') {
                return Err("bad struct mask".into());
            }
            let mask = mask_str.bytes().map(|c| c != b'.').collect();
            Ok(Pat::Struct { mask, child: Box::new(node(r, depth + 1)?) })
        }
        10 => {
            // Chunk(n, idx) decoded as a single-slot struct: cheaper and
            // shares the intersection logic.
            let n = r.u64()? as i64;
            if n <= 0 || n > 4096 {
                return Err("bad chunk count".into());
            }
            let idx = (r.u64()? as i64).rem_euclid(n);
            let child = Box::new(node(r, depth + 1)?);
            let mask = (0..n).map(|i| i == idx).collect();
            Ok(Pat::Struct { mask, child })
        }
        11 => {
            let slot = r.u8()? as usize;
            let v = r.f64()?;
            if slot >= NCTL {
                return Err(format!("ctl slot {slot} out of range"));
            }
            Ok(Pat::SetCtl(slot, v, Box::new(node(r, depth + 1)?)))
        }
        12 => {
            let s = r.str()?;
            if s.len() > 127 || !s.is_ascii() { return Err("bad instrument name".into()); }
            Ok(Pat::SetSound(s, Box::new(node(r, depth + 1)?)))
        }
        13 => {
            let d = r.f64()?;
            if !d.is_finite() { return Err("bad shift".into()); }
            Ok(Pat::Shift(d, Box::new(node(r, depth + 1)?)))
        }
        14 => {
            let p = r.f64()?;
            if !p.is_finite() || !(0.0..=1.0).contains(&p) { return Err("bad probability".into()); }
            let step = Box::new(node(r, depth + 1)?);
            let child = Box::new(node(r, depth + 1)?);
            Ok(Pat::Sometimes(p.clamp(0.0, 1.0), step, child))
        }
        15 => {
            let slot = r.u8()? as usize;
            let delta = r.f64()?;
            if !delta.is_finite() { return Err("bad transpose offset".into()); }
            if slot >= NCTL {
                return Err(format!("ctl slot {slot} out of range"));
            }
            Ok(Pat::AddCtl(slot, delta, Box::new(node(r, depth + 1)?)))
        }
        16 => {
            let n = r.u64()? as i64;
            if n <= 0 || n > 4096 {
                return Err("bad chunk count".into());
            }
            let step = Box::new(node(r, depth + 1)?);
            let child = Box::new(node(r, depth + 1)?);
            Ok(Pat::Chunk(n, step, child))
        }
        17 => Ok(Pat::WithNote(Box::new(node(r, depth + 1)?), Box::new(node(r, depth + 1)?))),
        t => Err(format!("unknown IR tag {t}")),
    }
}

fn children(r: &mut Reader, depth: usize) -> Result<Vec<Pat>, String> {
    let n = r.u32()? as usize;
    if n == 0 || n > 1024 {
        return Err(format!("bad child count {n}"));
    }
    (0..n).map(|_| node(r, depth + 1)).collect()
}

pub fn decode(bytes: &[u8]) -> Result<Pat, String> {
    let mut r = Reader { b: bytes, i: 0, nodes: 0 };
    if r.take(4)? != b"MUSE" {
        return Err("bad magic".into());
    }
    let v = r.u32()?;
    if v != 1 {
        return Err(format!("unsupported IR version {v}"));
    }
    let p = node(&mut r, 0)?;
    if r.i != bytes.len() { return Err("trailing bytes in pattern IR".into()); }
    Ok(p)
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_numeric_fields_and_trailing_bytes() {
        let scalar = |tag: u8, value: f64| {
            let mut bytes = b"MUSE".to_vec();
            bytes.extend(1u32.to_le_bytes());
            bytes.push(tag);
            bytes.extend(value.to_le_bytes());
            bytes.push(0);
            bytes
        };
        for value in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(decode(&scalar(4, value)).is_err());
            assert!(decode(&scalar(5, value)).is_err());
        }
        assert!(decode(&scalar(13, f64::NAN)).is_err());
        let mut trailing = scalar(4, 2.0);
        trailing.push(0);
        assert!(decode(&trailing).unwrap_err().contains("trailing bytes"));
    }

    #[test]
    fn rejects_large_wire_trees_without_js_validation() {
        let mut bytes = b"MUSE".to_vec();
        bytes.extend(1u32.to_le_bytes());
        bytes.push(3); // overlay of 32 overlays, each containing 1024 rests
        bytes.extend(32u32.to_le_bytes());
        for _ in 0..32 {
            bytes.push(3);
            bytes.extend(1024u32.to_le_bytes());
            bytes.extend([0; 1024]);
        }
        assert!(decode(&bytes).unwrap_err().contains("too many nodes"));
    }
}
