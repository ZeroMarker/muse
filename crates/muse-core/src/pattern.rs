//! The pattern query engine: `query(pat, span) -> haps`.
//!
//! Time is measured in **cycles** (one cycle = one iteration of the pattern).
//! A *hap* is an event with:
//!   * `whole` — the full extent of the event (onset = `whole.start`,
//!     duration = `whole` length),
//!   * `part`  — the portion visible inside the requested span (for display),
//!   * `ctl`   — controls; `NaN` means "unset, use default",
//!   * `sound` — the instrument token.
//!
//! Queries may legitimately return an event more than once (e.g. clipped per
//! display span); the scheduler deduplicates by filtering
//! `whole.start ∈ [window_start, window_end)`.

use crate::ir::{Pat, NCTL};

const MAX_CYCLES: i64 = 1 << 16;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Span {
    pub start: f64,
    pub end: f64,
}

impl Span {
    pub fn new(start: f64, end: f64) -> Self {
        Span { start, end }
    }

    pub fn len(&self) -> f64 {
        self.end - self.start
    }

    pub fn is_empty(&self) -> bool {
        self.end <= self.start || self.len() < 1e-12
    }

    pub fn intersect(&self, o: Span) -> Span {
        Span::new(self.start.max(o.start), self.end.min(o.end))
    }

    /// Integer cycles touched by this half-open span.
    pub fn cycles(&self) -> std::ops::Range<i64> {
        if self.is_empty() {
            return 0..0;
        }
        let first = self.start.floor() as i64;
        let last = (self.end.ceil() as i64) - 1;
        let last = last.min(first + MAX_CYCLES);
        if last < first {
            return 0..0;
        }
        first..(last + 1)
    }
}

#[derive(Clone, Debug)]
pub struct Hap {
    pub whole: Span,
    pub part: Span,
    pub ctl: [f64; NCTL],
    pub sound: String,
}

/// Deterministic per-cycle hash mapped to [0, 1).
fn cycle_rand(c: i64) -> f64 {
    let mut x = c as u64;
    x ^= x >> 30;
    x = x.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    x ^= x >> 27;
    x = x.wrapping_mul(0x94d0_49bb_1331_11eb);
    x ^= x >> 31;
    (x >> 11) as f64 / (1u64 << 53) as f64
}

struct Budget { work: usize, events: usize, exceeded: bool }

impl Budget {
    fn spend(&mut self, amount: usize) -> bool {
        self.work = self.work.saturating_add(amount);
        if self.work > 100_000 { self.exceeded = true; }
        !self.exceeded
    }
    fn event(&mut self) -> bool {
        self.events += 1;
        if self.events > 16_384 { self.exceeded = true; }
        self.spend(1)
    }
}

/// Bound intermediate work as well as the final event vector.
pub fn query_bounded(pat: &Pat, span: Span) -> Result<Vec<Hap>, ()> {
    let mut budget = Budget { work: 0, events: 0, exceeded: false };
    let result = query_inner(pat, span, &mut budget);
    if budget.exceeded { Err(()) } else { Ok(result) }
}

#[cfg(test)]
pub fn query(pat: &Pat, span: Span) -> Vec<Hap> {
    query_bounded(pat, span).expect("test query exceeded budget")
}

fn query_inner(pat: &Pat, span: Span, budget: &mut Budget) -> Vec<Hap> {
    if !budget.spend(1) { return Vec::new(); }
    if !span.start.is_finite() || !span.end.is_finite()
        || span.start.abs() > 1e12 || span.end.abs() > 1e12
        || span.end.ceil() - span.start.floor() > MAX_CYCLES as f64 {
        budget.exceeded = true;
        return Vec::new();
    }
    if span.is_empty() {
        return Vec::new();
    }
    let result = match pat {
        Pat::WithNote(pitches, kid) => {
            let events = query_inner(kid, span, budget);
            let lo = events.iter().fold(span.start, |lo, h| lo.min(h.whole.start));
            let notes = query_inner(pitches, Span::new(lo, span.end), budget);
            let mut out = Vec::new();
            for event in events {
                for pitch in &notes {
                    if !budget.spend(1) { return Vec::new(); }
                    if pitch.whole.start <= event.whole.start && event.whole.start < pitch.whole.end {
                        if !budget.event() { return Vec::new(); }
                        let mut h = event.clone();
                        h.ctl[crate::ir::CTL_NOTE] = pitch.ctl[crate::ir::CTL_NOTE];
                        out.push(h);
                    }
                }
            }
            out
        }
        Pat::Rest => Vec::new(),

        Pat::Atom { sound, ctl } => {
            let mut out = Vec::new();
            for c in span.cycles() {
                if !budget.spend(1) { return Vec::new(); }
                let whole = Span::new(c as f64, c as f64 + 1.0);
                let part = whole.intersect(span);
                if !part.is_empty() {
                    if !budget.event() { return Vec::new(); }
                    out.push(Hap { whole, part, ctl: *ctl, sound: sound.clone() });
                }
            }
            out
        }

        Pat::Cat(kids) => {
            if kids.is_empty() {
                return Vec::new();
            }
            let n = kids.len() as f64;
            let mut out = Vec::new();
            for c in span.cycles() {
                if !budget.spend(1) { return Vec::new(); }
                let base = c as f64;
                for (i, kid) in kids.iter().enumerate() {
                    if !budget.spend(1) { return Vec::new(); }
                    let slot = Span::new(base + i as f64 / n, base + (i + 1) as f64 / n);
                    let q = slot.intersect(span);
                    if q.is_empty() {
                        continue;
                    }
                    for mut h in query_inner(kid, q, budget) {
                        h.whole = h.whole.intersect(slot);
                        h.part = h.part.intersect(q);
                        if !h.whole.is_empty() && !h.part.is_empty() {
                            out.push(h);
                        }
                    }
                }
            }
            out
        }

        Pat::Overlay(kids) => {
            let mut out = Vec::new();
            for kid in kids {
                if !budget.spend(1) { return Vec::new(); }
                out.extend(query_inner(kid, span, budget));
            }
            out
        }

        Pat::Fast(k, kid) => {
            let k = if k.is_finite() && *k > 0.0 { *k } else { 1.0 };
            let inner = Span::new(span.start * k, span.end * k);
            if inner.is_empty() {
                return Vec::new();
            }
            query_inner(kid, inner, budget)
                .into_iter()
                .map(|mut h| {
                    h.whole = Span::new(h.whole.start / k, h.whole.end / k);
                    h.part = Span::new(h.part.start / k, h.part.end / k);
                    h
                })
                .collect()
        }

        Pat::Every(n, step, kid) => {
            let n = (*n).max(1);
            let mut out = Vec::new();
            for c in span.cycles() {
                if !budget.spend(1) { return Vec::new(); }
                let cs = Span::new(c as f64, c as f64 + 1.0).intersect(span);
                if cs.is_empty() {
                    continue;
                }
                let source = if c.rem_euclid(n) == 0 { step } else { kid };
                for mut h in query_inner(source, cs, budget) {
                    h.part = h.part.intersect(cs);
                    if !h.part.is_empty() && !h.whole.is_empty() {
                        out.push(h);
                    }
                }
            }
            out
        }

        Pat::Sometimes(prob, step, kid) => {
            let mut out = Vec::new();
            for c in span.cycles() {
                if !budget.spend(1) { return Vec::new(); }
                let cs = Span::new(c as f64, c as f64 + 1.0).intersect(span);
                if cs.is_empty() {
                    continue;
                }
                let source = if cycle_rand(c) < *prob { step } else { kid };
                for mut h in query_inner(source, cs, budget) {
                    h.part = h.part.intersect(cs);
                    if !h.part.is_empty() && !h.whole.is_empty() {
                        out.push(h);
                    }
                }
            }
            out
        }

        Pat::Rev(kid) => {
            let mut out = Vec::new();
            for c in span.cycles() {
                if !budget.spend(1) { return Vec::new(); }
                let base = c as f64;
                let local = Span::new(base, base + 1.0).intersect(span);
                if local.is_empty() {
                    continue;
                }
                let mirrored = Span::new(2.0 * base + 1.0 - local.end, 2.0 * base + 1.0 - local.start);
                for mut h in query_inner(kid, mirrored, budget) {
                    h.whole = Span::new(2.0 * base + 1.0 - h.whole.end, 2.0 * base + 1.0 - h.whole.start);
                    h.part = Span::new(2.0 * base + 1.0 - h.part.end, 2.0 * base + 1.0 - h.part.start)
                        .intersect(local);
                    if !h.whole.is_empty() && !h.part.is_empty() {
                        out.push(h);
                    }
                }
            }
            out
        }

        Pat::Altern(kids) => {
            if kids.is_empty() {
                return Vec::new();
            }
            let n = kids.len() as i64;
            let mut out = Vec::new();
            for c in span.cycles() {
                if !budget.spend(1) { return Vec::new(); }
                let cs = Span::new(c as f64, c as f64 + 1.0).intersect(span);
                if cs.is_empty() {
                    continue;
                }
                let idx = c.rem_euclid(n) as usize;
                for mut h in query_inner(&kids[idx], cs, budget) {
                    h.part = h.part.intersect(cs);
                    if !h.part.is_empty() && !h.whole.is_empty() {
                        out.push(h);
                    }
                }
            }
            out
        }

        Pat::Struct { mask, child } => {
            if mask.is_empty() {
                return Vec::new();
            }
            let n = mask.len() as f64;
            let mut out = Vec::new();
            for c in span.cycles() {
                if !budget.spend(1) { return Vec::new(); }
                let base = c as f64;
                for (i, hit) in mask.iter().enumerate() {
                    if !budget.spend(1) { return Vec::new(); }
                    if !hit {
                        continue;
                    }
                    let slot = Span::new(base + i as f64 / n, base + (i + 1) as f64 / n);
                    let q = slot.intersect(span);
                    if q.is_empty() {
                        continue;
                    }
                    for mut h in query_inner(child, q, budget) {
                        h.whole = h.whole.intersect(slot);
                        h.part = h.part.intersect(q);
                        if !h.whole.is_empty() && !h.part.is_empty() {
                            out.push(h);
                        }
                    }
                }
            }
            out
        }

        Pat::Shift(d, kid) => {
            query_inner(kid, Span::new(span.start - d, span.end - d), budget)
                .into_iter()
                .map(|mut h| {
                    h.whole = Span::new(h.whole.start + d, h.whole.end + d);
                    h.part = Span::new(h.part.start + d, h.part.end + d);
                    h
                })
                .collect()
        }

        Pat::SetCtl(slot, v, kid) => {
            query_inner(kid, span, budget)
                .into_iter()
                .map(|mut h| {
                    h.ctl[*slot] = *v;
                    h
                })
                .collect()
        }

        Pat::SetSound(s, kid) => {
            query_inner(kid, span, budget)
                .into_iter()
                .map(|mut h| {
                    h.sound = s.clone();
                    h
                })
                .collect()
        }

        Pat::AddCtl(slot, delta, kid) => {
            let (base_default, delta) = (*slot, *delta);
            query_inner(kid, span, budget)
                .into_iter()
                .map(|mut h| {
                    let base = if h.ctl[base_default].is_finite() {
                        h.ctl[base_default]
                    } else {
                        crate::ir::DEFAULTS[base_default]
                    };
                    h.ctl[base_default] = base + delta;
                    h
                })
                .collect()
        }

        Pat::Chunk(n, step, kid) => {
            let n = (*n).max(1);
            let nf = n as f64;
            let mut out = Vec::new();
            for c in span.cycles() {
                if !budget.spend(1) { return Vec::new(); }
                let base = c as f64;
                let idx = c.rem_euclid(n);
                for i in 0..n {
                    if !budget.spend(1) { return Vec::new(); }
                    let slot = Span::new(base + i as f64 / nf, base + (i + 1) as f64 / nf);
                    let q = slot.intersect(span);
                    if q.is_empty() {
                        continue;
                    }
                    let src = if i == idx { step } else { kid };
                    for mut h in query_inner(src, q, budget) {
                        h.whole = h.whole.intersect(slot);
                        h.part = h.part.intersect(q);
                        if !h.whole.is_empty() && !h.part.is_empty() {
                            out.push(h);
                        }
                    }
                }
            }
            out
        }
    };
    if !budget.spend(result.len()) { return Vec::new(); }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::{CTL_GAIN, CTL_NOTE};

    fn atom(sound: &str) -> Pat {
        let mut ctl = [f64::NAN; NCTL];
        ctl[CTL_NOTE] = 60.0;
        Pat::Atom { sound: sound.into(), ctl }
    }

    fn onsets(p: &Pat, lo: f64, hi: f64) -> Vec<f64> {
        let round = |x: f64| (x * 1e6).round() / 1e6;
        let mut v: Vec<f64> = query(p, Span::new(lo, hi))
            .into_iter()
            .filter(|h| h.whole.start >= lo && h.whole.start < hi)
            .map(|h| round(h.whole.start))
            .collect();
        v.sort_by(f64::total_cmp);
        v
    }

    #[test]
    fn atom_once_per_cycle() {
        let p = atom("bd");
        assert_eq!(onsets(&p, 0.0, 3.0), vec![0.0, 1.0, 2.0]);
    }

    #[test]
    fn cat_splits_cycle() {
        let p = Pat::Cat(vec![atom("a"), atom("b"), atom("c")]);
        assert_eq!(
            onsets(&p, 0.0, 1.0),
            vec![
                0.0,
                (1.0f64 / 3.0 * 1e6).round() / 1e6,
                (2.0f64 / 3.0 * 1e6).round() / 1e6
            ]
        );
    }

    #[test]
    fn overlay_stacks() {
        let p = Pat::Overlay(vec![atom("a"), Pat::Cat(vec![atom("b"), atom("c")])]);
        let mut o = onsets(&p, 0.0, 1.0);
        assert_eq!(o.len(), 3);
        o.clear();
        assert_eq!(onsets(&p, 0.0, 1.0).len(), 3);
    }

    #[test]
    fn fast_doubles_density() {
        let p = Pat::Fast(2.0, Box::new(atom("a")));
        assert_eq!(onsets(&p, 0.0, 1.0), vec![0.0, 0.5]);
    }

    #[test]
    fn slow_halves_density_and_lengthens() {
        let p = Pat::Fast(0.5, Box::new(atom("a")));
        let haps = query(&p, Span::new(0.0, 2.0));
        let first = haps.iter().find(|h| h.whole.start == 0.0).unwrap();
        assert!((first.whole.len() - 2.0).abs() < 1e-9);
        assert_eq!(onsets(&p, 0.0, 4.0), vec![0.0, 2.0]);
    }

    #[test]
    fn every_applies_step_every_nth_cycle() {
        let p = Pat::Every(2, Box::new(Pat::Fast(2.0, Box::new(atom("a")))), Box::new(atom("a")));
        // cycle 0: fast -> 0, .5 ; cycle 1: base -> 1 ; cycle 2: fast -> 2, 2.5
        assert_eq!(onsets(&p, 0.0, 3.0), vec![0.0, 0.5, 1.0, 2.0, 2.5]);
    }

    #[test]
    fn rev_mirrors_within_cycle() {
        // events at 0, .25, .5 mirrored -> 0, .5, .75
        let p = Pat::Cat(vec![atom("a"), atom("b"), atom("c"), Pat::Rest]);
        assert_eq!(onsets(&p, 0.0, 1.0), vec![0.0, 0.25, 0.5]);
        // events at [0,.25) [.25,.5) [.5,.75) mirror to [.75,1) [.5,.75) [.25,.5)
        let pr = Pat::Rev(Box::new(p));
        assert_eq!(onsets(&pr, 0.0, 1.0), vec![0.25, 0.5, 0.75]);
        // fast pattern reversed keeps the symmetric onset set {0, .5}
        let p2 = Pat::Rev(Box::new(Pat::Fast(2.0, Box::new(atom("x")))));
        assert_eq!(onsets(&p2, 0.0, 1.0), vec![0.0, 0.5]);
    }

    #[test]
    fn rev_preserves_cycle_dependent_content_and_is_an_involution() {
        let p = Pat::Altern(vec![
            Pat::Cat(vec![atom("a"), atom("b")]),
            Pat::Cat(vec![atom("c"), atom("d")]),
        ]);
        let reversed = Pat::Rev(Box::new(p.clone()));
        for cycle in [-3.0, -1.0, 1.0, 3.0] {
            let events = query(&reversed, Span::new(cycle, cycle + 1.0));
            assert_eq!(events.iter().map(|h| h.sound.as_str()).collect::<Vec<_>>(), vec!["c", "d"]);
            assert_eq!(events[0].whole.start, cycle + 0.5);
            assert_eq!(events[1].whole.start, cycle);
        }
        let twice = Pat::Rev(Box::new(reversed));
        let original = query(&p, Span::new(-2.0, 4.0));
        let restored = query(&twice, Span::new(-2.0, 4.0));
        assert_eq!(original.iter().map(|h| (&h.sound, h.whole)).collect::<Vec<_>>(),
                   restored.iter().map(|h| (&h.sound, h.whole)).collect::<Vec<_>>());
        let clipped = query(&twice, Span::new(1.25, 1.75));
        assert_eq!(clipped.iter().map(|h| h.part).collect::<Vec<_>>(),
                   vec![Span::new(1.25, 1.5), Span::new(1.5, 1.75)]);
    }

    #[test]
    fn altern_cycles_children() {
        let p = Pat::Altern(vec![atom("a"), Pat::Cat(vec![atom("b"), atom("b")])]);
        assert_eq!(onsets(&p, 0.0, 2.0), vec![0.0, 1.0, 1.5]);
    }

    #[test]
    fn struct_masks_events() {
        // hits on slots 0 and 2 of 4
        let p = Pat::Struct {
            mask: vec![true, false, true, false],
            child: Box::new(atom("a")),
        };
        assert_eq!(onsets(&p, 0.0, 1.0), vec![0.0, 0.5]);
        // whole clipped to slots
        let h = query(&p, Span::new(0.0, 1.0)).into_iter().next().unwrap();
        assert!((h.whole.len() - 0.25).abs() < 1e-9);
    }

    #[test]
    fn euclid_like_struct_on_subdivided_child() {
        // child subdivided 4x per cycle, masked x.xx. -> hits at 0, .75
        let child = Pat::Cat(vec![atom("a"); 4]);
        let p = Pat::Struct { mask: vec![true, false, true, true], child: Box::new(child) };
        assert_eq!(onsets(&p, 0.0, 1.0), vec![0.0, 0.5, 0.75]);
    }

    #[test]
    fn set_ctl_overrides_atom() {
        let mut p = atom("a");
        if let Pat::Atom { ctl, .. } = &mut p {
            ctl[CTL_GAIN] = 0.2;
        }
        let wrapped = Pat::SetCtl(CTL_GAIN, 0.9, Box::new(p));
        let h = query(&wrapped, Span::new(0.0, 1.0)).into_iter().next().unwrap();
        assert_eq!(h.ctl[CTL_GAIN], 0.9);
        assert!(h.ctl[CTL_NOTE].is_finite());
    }

    #[test]
    fn shift_moves_time() {
        let p = Pat::Shift(0.25, Box::new(atom("a")));
        let onset = onsets(&p, 0.0, 2.0).into_iter().next().unwrap();
        assert!((onset - 0.25).abs() < 1e-9);
    }

    #[test]
    fn nested_fast_slow_cancel() {
        let p = Pat::Fast(2.0, Box::new(Pat::Fast(0.5, Box::new(atom("a")))));
        assert_eq!(onsets(&p, 0.0, 2.0), vec![0.0, 1.0]);
    }

    #[test]
    fn span_cycles_edges() {
        assert_eq!(Span::new(0.0, 3.0).cycles().collect::<Vec<_>>(), vec![0, 1, 2]);
        assert_eq!(Span::new(0.0, 3.5).cycles().collect::<Vec<_>>(), vec![0, 1, 2, 3]);
        assert_eq!(Span::new(-1.5, 0.0).cycles().collect::<Vec<_>>(), vec![-2, -1]);
    }
}

#[cfg(test)]
mod chunk_tests {
    use super::*;
    use crate::ir::NCTL;

    fn atom(sound: &str) -> Pat {
        Pat::Atom { sound: sound.into(), ctl: [f64::NAN; NCTL] }
    }

    fn onsets(p: &Pat, lo: f64, hi: f64) -> Vec<f64> {
        let round = |x: f64| (x * 1e6).round() / 1e6;
        let mut v: Vec<f64> = query(p, Span::new(lo, hi))
            .into_iter()
            .filter(|h| h.whole.start >= lo && h.whole.start < hi)
            .map(|h| round(h.whole.start))
            .collect();
        v.sort_by(f64::total_cmp);
        v
    }

    #[test]
    fn chunk_applies_step_to_moving_slot() {
        // 4-slot cycle, step doubles density in the active slot
        let four = Pat::Cat(vec![atom("a"); 4]);
        let p = Pat::Chunk(4, Box::new(Pat::Fast(2.0, Box::new(four.clone()))), Box::new(four));
        // cycle 0: slot 0 fast -> 0, .125, .25(?) .. plain slots at .25 .5 .75
        let o = onsets(&p, 0.0, 2.0);
        // cycle 0 has an extra onset inside slot 0 (fast(2) of the slot pattern)
        assert!(o.contains(&0.125), "{o:?}");
        // cycle 1: extra onset inside slot 1
        assert!(o.contains(&1.375), "{o:?}");
    }
}
