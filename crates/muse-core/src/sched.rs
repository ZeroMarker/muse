//! Clock + lookahead scheduler.
//!
//! The clock maps audio-context time to cycle position:
//!
//! ```text
//! cycle(t) = epoch_cycle + (t - epoch_audio) * cps
//! ```
//!
//! The scheduler keeps a *cursor*: everything before it has already been
//! packed and handed to the audio worklet. Each tick queries
//! `[cursor, horizon)` and advances the cursor — so every onset is scheduled
//! exactly once, and no events are missed when the window slides.

use crate::ir::{Pat, DEFAULTS, NCTL};
use crate::pattern::{query, Hap, Span};

/// Bytes per packed event header (before the variable-length sound name):
/// onset f64 + dur f64 + ctl[NCTL] f64.
pub const EVENT_HEADER: usize = 8 + 8 + 8 * NCTL;

pub struct Sched {
    pub pat: Option<Pat>,
    pub cps: f64,
    epoch_audio: f64,
    epoch_cycle: f64,
    cursor: f64,
}

impl Sched {
    pub fn new(cps: f64) -> Self {
        Sched { pat: None, cps, epoch_audio: 0.0, epoch_cycle: 0.0, cursor: 0.0 }
    }

    pub fn cycle_at(&self, audio_now: f64) -> f64 {
        self.epoch_cycle + (audio_now - self.epoch_audio) * self.cps
    }

    /// Inverse of [`Sched::cycle_at`]: audio-context time of a cycle position.
    pub fn audio_at(&self, cycle: f64) -> f64 {
        self.epoch_audio + (cycle - self.epoch_cycle) / self.cps
    }

    /// Rebase the clock at `audio_now`, keeping the current cycle position.
    pub fn set_cps(&mut self, cps: f64, audio_now: f64) {
        let cur = self.cycle_at(audio_now);
        self.epoch_audio = audio_now;
        self.epoch_cycle = cur;
        self.cps = cps;
        // Never move the cursor backwards: already-scheduled events stay sent.
        self.cursor = self.cursor.max(cur);
    }

    /// Restart scheduling from the current cycle (play, pattern swap).
    pub fn reset(&mut self, audio_now: f64) {
        self.cursor = self.cycle_at(audio_now);
    }

    fn haps(&self, lo: f64, hi: f64) -> Vec<Hap> {
        let Some(pat) = &self.pat else { return Vec::new() };
        if hi <= lo {
            return Vec::new();
        }
        let mut haps = query(pat, Span::new(lo, hi));
        // Dedup + drop events whose onset already passed the window start.
        haps.retain(|h| h.whole.start >= lo && h.whole.start < hi && h.whole.len() > 1e-9);
        haps.sort_by(|a, b| a.whole.start.total_cmp(&b.whole.start));
        haps.dedup_by(|a, b| {
            a.whole.start == b.whole.start
                && a.whole.end == b.whole.end
                && a.sound == b.sound
                && a.ctl == b.ctl
        });
        haps
    }

    /// Number of events in the un-scheduled window `[cursor, horizon)`.
    pub fn count(&self, horizon: f64) -> usize {
        self.haps(self.cursor, horizon).len()
    }

    /// Pack events from `[cursor, horizon)` into `out`, advancing the cursor.
    pub fn query(&mut self, horizon: f64, out: &mut [u8]) -> Result<usize, ()> {
        let lo = self.cursor;
        let n = self.pack_range(lo, horizon, out)?;
        if horizon > lo {
            self.cursor = horizon;
        }
        Ok(n)
    }

    /// Pack events with onset in `[lo, hi)` without touching the cursor.
    pub fn pack_range(&self, lo: f64, hi: f64, out: &mut [u8]) -> Result<usize, ()> {
        let haps = self.haps(lo, hi);
        let mut i = 0usize;
        for h in &haps {
            let sound = h.sound.as_bytes();
            let need = EVENT_HEADER + 2 + sound.len();
            if i + need > out.len() {
                return Err(());
            }
            let dur_cycles = h.whole.len();
            let dur_sec = dur_cycles / self.cps; // carried for convenience
            out[i..i + 8].copy_from_slice(&h.whole.start.to_le_bytes());
            i += 8;
            out[i..i + 8].copy_from_slice(&dur_sec.to_le_bytes());
            i += 8;
            for s in 0..NCTL {
                let v = if h.ctl[s].is_finite() { h.ctl[s] } else { DEFAULTS[s] };
                out[i..i + 8].copy_from_slice(&v.to_le_bytes());
                i += 8;
            }
            out[i..i + 2].copy_from_slice(&(sound.len() as u16).to_le_bytes());
            i += 2;
            out[i..i + sound.len()].copy_from_slice(sound);
            i += sound.len();
        }
        Ok(i)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::{Pat, NCTL};

    fn atom(sound: &str) -> Pat {
        Pat::Atom { sound: sound.into(), ctl: [f64::NAN; NCTL] }
    }

    /// Parse packed events back out: (onset_cycle, dur_sec, ctl, sound).
    fn unpack(buf: &[u8]) -> Vec<(f64, f64, [f64; NCTL], String)> {
        let mut out = Vec::new();
        let mut i = 0;
        while i < buf.len() {
            let onset = f64::from_le_bytes(buf[i..i + 8].try_into().unwrap());
            let dur = f64::from_le_bytes(buf[i + 8..i + 16].try_into().unwrap());
            i += 16;
            let mut ctl = [0.0; NCTL];
            for s in ctl.iter_mut() {
                *s = f64::from_le_bytes(buf[i..i + 8].try_into().unwrap());
                i += 8;
            }
            let sl = u16::from_le_bytes(buf[i..i + 2].try_into().unwrap()) as usize;
            i += 2;
            let sound = String::from_utf8(buf[i..i + sl].to_vec()).unwrap();
            i += sl;
            out.push((onset, dur, ctl, sound));
        }
        out
    }

    #[test]
    fn clock_math() {
        let mut s = Sched::new(2.0); // 2 cycles per second
        assert_eq!(s.cycle_at(0.0), 0.0);
        assert_eq!(s.cycle_at(1.5), 3.0);
        // tempo change rebases in place
        s.set_cps(1.0, 2.0);
        assert_eq!(s.cycle_at(2.0), 4.0);
        assert_eq!(s.cycle_at(4.0), 6.0);
    }

    #[test]
    fn cursor_advances_once() {
        let mut s = Sched::new(1.0);
        s.pat = Some(atom("bd"));
        s.reset(0.0);
        let mut buf = vec![0u8; 4096];
        // window [0, 2): two events
        let n = s.query(2.0, &mut buf).unwrap();
        assert_eq!(unpack(&buf[..n]).len(), 2);
        // second call: cursor is at 2, horizon 2 -> nothing new
        let n2 = s.query(2.0, &mut buf).unwrap();
        assert_eq!(n2, 0);
        // extend to 4 -> two more
        let n3 = s.query(4.0, &mut buf).unwrap();
        let evs = unpack(&buf[..n3]);
        assert_eq!(evs.len(), 2);
        assert_eq!(evs[0].0, 2.0);
        assert_eq!(evs[1].0, 3.0);
    }

    #[test]
    fn defaults_fill_nan_slots() {
        let mut s = Sched::new(1.0);
        s.pat = Some(atom("bd"));
        s.reset(0.0);
        let mut buf = vec![0u8; 4096];
        let n = s.query(1.0, &mut buf).unwrap();
        let evs = unpack(&buf[..n]);
        assert_eq!(evs[0].2[crate::ir::CTL_GAIN], crate::ir::DEFAULTS[crate::ir::CTL_GAIN]);
        assert_eq!(evs[0].3, "bd");
        // dur of a whole-cycle event at 1 cps = 1s
        assert!((evs[0].1 - 1.0).abs() < 1e-9);
    }

    #[test]
    fn too_small_buffer_errors() {
        let mut s = Sched::new(1.0);
        s.pat = Some(atom("bd"));
        s.reset(0.0);
        let mut buf = vec![0u8; 4];
        assert!(s.query(1.0, &mut buf).is_err());
    }

    #[test]
    fn no_pattern_no_events() {
        let mut s = Sched::new(1.0);
        s.reset(0.0);
        assert_eq!(s.count(100.0), 0);
    }
}
