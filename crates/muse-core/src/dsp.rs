//! The DSP engine that runs inside the AudioWorklet.
//!
//! * `schedule()` queues a note at an absolute audio-context time,
//! * `process()` renders a quantum sample-accurately (voices may start
//!   mid-quantum), mixing: voices → panner → delay send → soft clip.
//!
//! Instruments: pitched oscillators (`sine saw square tri noise`) and drum
//! voices (`bd sn hh oh cp tom`) selected by the event's `sound` token.

use crate::ir::{CTL_ATTACK, CTL_CRUSH, CTL_CUTOFF, CTL_DECAY, CTL_DELAY, CTL_GAIN, CTL_NOTE,
                CTL_PAN, CTL_RESONANCE, CTL_RELEASE, CTL_SPEED, CTL_SUSTAIN, NCTL};

use std::{collections::HashMap, sync::Arc};

const MAX_VOICES: usize = 128;
const MAX_PENDING: usize = 4096;
/// Master gain: stacked layers used to sit on the soft-clip ceiling.
const MASTER: f64 = 0.25;

#[derive(Clone, Copy, PartialEq)]
enum Wave {
    Sine,
    Saw,
    Square,
    Tri,
    Noise,
    Pulse,
    Organ,
    Bd,
    Sn,
    Hh,
    Oh,
    Cp,
    Tom,
}

fn wave_from_name(s: &str) -> Wave {
    match s {
        "sine" | "sin" => Wave::Sine,
        "sawtooth" | "saw" => Wave::Saw,
        "square" | "sq" => Wave::Square,
        "tri" | "triangle" => Wave::Tri,
        "noise" | "nz" => Wave::Noise,
        "pulse" => Wave::Pulse,
        "organ" => Wave::Organ,
        "bd" | "kick" => Wave::Bd,
        "sn" | "snare" => Wave::Sn,
        "hh" | "hat" | "hhc" => Wave::Hh,
        "oh" => Wave::Oh,
        "cp" | "clap" => Wave::Cp,
        "tom" => Wave::Tom,
        _ => Wave::Saw,
    }
}

fn midi_to_freq(m: f64) -> f64 {
    440.0 * (2.0f64).powf((m - 69.0) / 12.0)
}

#[derive(Clone)]
struct Sample {
    data: Arc<Vec<f32>>,
    rate: f64,
}

struct Pending {
    start_frame: i64,
    dur: f64,
    ctl: [f64; NCTL],
    wave: Wave,
    sample: Option<Sample>,
}

struct Voice {
    wave: Wave,
    sample: Option<Sample>,
    sample_speed: f64,
    start_frame: i64,
    dur: f64, // seconds (gate)
    // envelope
    a: f64,
    d: f64,
    s: f64,
    r: f64,
    // oscillator / drum pitch sweep
    freq: f64,
    freq_end: f64,
    tau: f64,
    phase: f64,
    rng: u32,
    // svf state
    g: f64,
    k: f64,
    ic1: f64,
    ic2: f64,
    filter: u8, // 0 = lp, 1 = bp, 2 = hp, 3 = none
    // output
    amp: f64,
    pan: f64,
    send: f64,
    crush: f64,
    sh_hold: f32,
    sh_count: u32,
}

impl Voice {
    fn alive(&self, t: f64) -> bool {
        t < self.dur + self.r + 1e-6 && t >= 0.0
    }

    fn env(&self, t: f64) -> f64 {
        if t < self.a {
            t / self.a.max(1e-6)
        } else if t < self.a + self.d {
            let x = (t - self.a) / self.d.max(1e-9);
            1.0 + (self.s - 1.0) * x
        } else if t < self.dur {
            self.s
        } else if t < self.dur + self.r {
            let x = (t - self.dur) / self.r.max(1e-9);
            self.s * 0.5 * (1.0 + (std::f64::consts::PI * x).cos())
        } else {
            0.0
        }
    }

    fn next_noise(&mut self) -> f64 {
        // xorshift32
        let mut x = self.rng;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.rng = x.max(1);
        (x as f64 / u32::MAX as f64) * 2.0 - 1.0
    }

    /// One sample at time `t` seconds since note start.
    fn sample(&mut self, t: f64, sr: f64) -> f64 {
        // --- pitch (drums sweep, pitched voices are constant) ---
        let f = if self.tau > 0.0 {
            self.freq_end + (self.freq - self.freq_end) * (-t / self.tau).exp()
        } else {
            self.freq
        };
        self.phase += f / sr;
        if self.phase >= 1.0 {
            self.phase -= self.phase.floor();
        }

        let env = self.env(t);
        if env <= 0.0 && t > self.dur {
            // fully dead after release; cheap early-out
            if t >= self.dur + self.r {
                return 0.0;
            }
        }

        let raw = if let Some(sample) = &self.sample {
            let position = t * sample.rate * self.sample_speed;
            let i = position.floor() as usize;
            let a = sample.data.get(i).copied().unwrap_or(0.0) as f64;
            let b = sample.data.get(i + 1).copied().unwrap_or(0.0) as f64;
            a + (b - a) * (position - position.floor())
        } else { match self.wave {
            Wave::Sine => (self.phase * std::f64::consts::TAU).sin(),
            Wave::Saw => self.phase * 2.0 - 1.0,
            Wave::Square => {
                if self.phase < 0.5 {
                    1.0
                } else {
                    -1.0
                }
            }
            Wave::Tri => 1.0 - 4.0 * (self.phase - 0.5).abs(),
            Wave::Pulse => if self.phase < 0.25 { 1.0 } else { -1.0 / 3.0 },
            Wave::Organ => ((self.phase * std::f64::consts::TAU).sin()
                + 0.5 * (self.phase * std::f64::consts::TAU * 2.0).sin()
                + 0.25 * (self.phase * std::f64::consts::TAU * 3.0).sin()) / 1.75,
            Wave::Noise => self.next_noise(),
            Wave::Bd => {
                let click = if t < 0.008 { self.next_noise() * 0.5 } else { 0.0 };
                (self.phase * std::f64::consts::TAU).sin() + click
            }
            Wave::Sn => {
                let tone = (self.phase * std::f64::consts::TAU).sin();
                tone * 0.35 + self.next_noise() * 0.8
            }
            Wave::Hh | Wave::Oh | Wave::Cp => self.next_noise(),
            Wave::Tom => (self.phase * std::f64::consts::TAU).sin(),
        }};

        let mut v = raw * env;

        // --- resonant filter (TPT/ZDF state variable) ---
        if self.filter != 3 {
            let hp = v - self.k * self.ic1 - self.ic2;
            let bp = self.g * hp + self.ic1;
            let lp = self.g * bp + self.ic2;
            self.ic1 = self.g * hp + bp;
            self.ic2 = self.g * bp + lp;
            v = match self.filter {
                0 => lp,
                1 => bp,
                2 => hp,
                _ => v,
            };
        }

        // --- bitcrush / sample-hold ---
        if self.crush > 0.0 {
            if self.sh_count == 0 {
                let bits = (14.0 * (1.0 - self.crush) + 2.0).max(1.0);
                let steps = (2.0f64.powf(bits)) as f64;
                self.sh_hold = ((v * steps).round() / steps) as f32;
                self.sh_count = 1 + (self.crush * 40.0) as u32;
            }
            self.sh_count -= 1;
            v = self.sh_hold as f64;
        }

        v * self.amp
    }
}

pub struct Dsp {
    sr: f64,
    samples: HashMap<String, Sample>,
    pending: Vec<Pending>,
    voices: Vec<Voice>,
    delay: Vec<f32>,
    delay_idx: usize,
    /// diagnostics: schedule() calls (before guards)
    pub sched_calls: u32,
    /// diagnostics: voices ever spawned
    pub spawned_total: u32,
    /// diagnostics: first schedule() argument seen
    pub first_at: f64,
}

impl Dsp {
    pub fn new(sample_rate: f64) -> Self {
        let sr = if sample_rate > 0.0 { sample_rate } else { 48000.0 };
        let dlen = (sr * 0.4).max(sr * 0.1) as usize;
        Dsp {
            sr,
            samples: HashMap::new(),
            pending: Vec::new(),
            voices: Vec::new(),
            delay: vec![0.0; dlen],
            delay_idx: 0,
            sched_calls: 0,
            spawned_total: 0,
            first_at: f64::NAN,
        }
    }

    pub fn load_sample(&mut self, name: &str, data: &[f32], rate: f64) -> bool {
        if name.is_empty() || name.len() > 127 || !name.is_ascii() || data.is_empty()
            || !rate.is_finite() || !(8000.0..=192000.0).contains(&rate)
            || data.len() > (rate * 30.0) as usize {
            return false;
        }
        self.samples.insert(name.to_owned(), Sample {
            data: Arc::new(data.iter().map(|v| if v.is_finite() { v.clamp(-1.0, 1.0) } else { 0.0 }).collect()),
            rate,
        });
        true
    }

    /// Queue a note at absolute time `at_sec`.
    pub fn schedule(&mut self, at_sec: f64, dur_sec: f64, ctl: &[f64; NCTL], sound: &str) {
        self.sched_calls = self.sched_calls.wrapping_add(1);
        if self.sched_calls == 1 {
            self.first_at = at_sec;
        }
        if self.pending.len() >= MAX_PENDING || !at_sec.is_finite() {
            return;
        }
        let start_frame = (at_sec * self.sr).round() as i64;
        self.pending.push(Pending {
            start_frame,
            dur: dur_sec.max(0.01),
            ctl: *ctl,
            wave: wave_from_name(sound),
            sample: self.samples.get(sound).cloned(),
        });
        self.pending.sort_by_key(|p| p.start_frame);
    }

    fn spawn(&mut self, p: &Pending) {
        let c = p.ctl;
        let wave = p.wave;
        let is_drum = p.sample.is_none() && matches!(wave, Wave::Bd | Wave::Sn | Wave::Hh | Wave::Oh | Wave::Cp | Wave::Tom);

        let freq = midi_to_freq(clamp_def(c[CTL_NOTE], -20.0, 140.0, 60.0))
            * clamp_def(c[CTL_SPEED], 0.01, 16.0, 1.0);
        let (freq_end, tau) = match wave {
            Wave::Bd => (45.0, 0.05),
            Wave::Sn => (160.0, 0.06),
            Wave::Tom => (freq * 0.4, 0.12),
            _ => (freq, 0.0),
        };

        let sr = self.sr;
        let fc = clamp_def(c[CTL_CUTOFF], 20.0, sr * 0.45, 12000.0);
        let g = (std::f64::consts::PI * fc / sr).tan();
        let q = 0.707 + clamp_def(c[CTL_RESONANCE], 0.0, 0.99, 0.1) * 6.0;
        let k = 1.0 / q;

        let filter = match wave {
            Wave::Hh | Wave::Oh => 2,        // highpass
            Wave::Sn | Wave::Cp => 1,        // bandpass
            Wave::Noise if c[CTL_CUTOFF].is_finite() => 0,
            Wave::Bd => 3,                   // no filter on kick
            _ => 0,                          // lowpass
        };

        // Drum envelopes shape themselves (sustain 0); pitched voices use
        // the gate duration.
        let (a, d, dur) = if is_drum {
            let decay = if c[CTL_DECAY].is_finite() && c[CTL_DECAY] > 0.0 {
                c[CTL_DECAY]
            } else {
                match wave {
                    Wave::Bd => 0.30,
                    Wave::Sn => 0.18,
                    Wave::Hh => 0.045,
                    Wave::Oh => 0.32,
                    Wave::Cp => 0.14,
                    _ => 0.25,
                }
            };
            (
                clamp_def(c[CTL_ATTACK], 1e-4, 0.01, 0.001),
                decay,
                decay + 1e-3,
            )
        } else {
            (
                clamp_def(c[CTL_ATTACK], 1e-4, 5.0, 0.005),
                clamp_def(c[CTL_DECAY], 0.0, 10.0, 0.05),
                if p.dur.is_finite() && p.dur > 0.0 { p.dur } else { 0.25 },
            )
        };
        let s = if is_drum { 0.0 } else { clamp_def(c[CTL_SUSTAIN], 0.0, 1.0, 1.0) };
        let r = clamp_def(c[CTL_RELEASE], 0.001, 5.0, 0.05);

        let v = Voice {
            wave,
            sample: p.sample.clone(),
            sample_speed: clamp_def(c[CTL_SPEED], 0.01, 16.0, 1.0)
                * (2.0f64).powf((clamp_def(c[CTL_NOTE], -20.0, 140.0, 60.0) - 60.0) / 12.0),
            start_frame: p.start_frame,
            dur,
            a,
            d,
            s,
            r,
            freq,
            freq_end,
            tau,
            phase: 0.0,
            rng: (p.start_frame as u32) ^ 0x9e37_79b9,
            g,
            k,
            ic1: 0.0,
            ic2: 0.0,
            filter,
            amp: clamp_def(c[CTL_GAIN], 0.0, 4.0, 1.0)
                * if matches!(wave, Wave::Hh | Wave::Oh) { 0.6 } else { 1.0 },
            pan: clamp_def(c[CTL_PAN], 0.0, 1.0, 0.5),
            send: clamp_def(c[CTL_DELAY], 0.0, 1.0, 0.0),
            crush: clamp_def(c[CTL_CRUSH], 0.0, 1.0, 0.0),
            sh_hold: 0.0,
            sh_count: 0,
        };

        self.spawned_total = self.spawned_total.wrapping_add(1);
        if self.voices.len() >= MAX_VOICES {
            // steal the oldest
            let oldest = self
                .voices
                .iter()
                .enumerate()
                .min_by_key(|(_, v)| v.start_frame)
                .map(|(i, _)| i);
            if let Some(i) = oldest {
                self.voices.remove(i);
            }
        }
        self.voices.push(v);
    }

    /// Render `n` frames; `base_frame` is the absolute frame of `left[0]`.
    pub fn process(&mut self, left: &mut [f32], right: &mut [f32], base_frame: i64) {
        let n = left.len().min(right.len());
        let sr = self.sr;

        // spawn voices whose start has been reached
        while let Some(pos) = self.pending.iter().position(|p| p.start_frame <= base_frame + n as i64)
        {
            let p = self.pending.remove(pos);
            self.spawn(&p);
        }

        // drop voices whose lifetime ended before this quantum
        let end_frame = base_frame + n as i64;
        self.voices.retain(|v| {
            let life = v.dur + v.r;
            (end_frame as f64) < (v.start_frame as f64 + life * sr) + sr
        });

        for s in 0..n {
            let frame = base_frame + s as i64;
            let mut l = 0.0f64;
            let mut r = 0.0f64;
            let mut send = 0.0f64;

            for v in self.voices.iter_mut() {
                if frame < v.start_frame {
                    continue;
                }
                let t = (frame - v.start_frame) as f64 / sr;
                if !v.alive(t) {
                    continue;
                }
                let out = v.sample(t, sr);
                let ang = v.pan as f64 * std::f64::consts::FRAC_PI_2;
                l += out * ang.cos();
                r += out * ang.sin();
                send += out * v.send;
            }

            // delay line (mono feedback) — NaN would circulate forever
            let di = self.delay_idx % self.delay.len();
            let delayed = self.delay[di];
            let delayed = if delayed.is_finite() { delayed as f64 } else { 0.0 };
            let send = if send.is_finite() { send } else { 0.0 };
            let fb = delayed as f32 * 0.35 + (send * 0.6) as f32;
            self.delay[di] = if fb.is_finite() { fb } else { 0.0 };
            self.delay_idx += 1;
            l += delayed * 0.5;
            r += delayed * 0.5;

            left[s] = soft_clip(l * MASTER) as f32;
            right[s] = soft_clip(r * MASTER) as f32;
        }

        // GC: remove dead voices to keep iteration cheap
        self.voices.retain(|v| {
            let t_end = (end_frame as f64 - v.start_frame as f64) / sr;
            t_end < v.dur + v.r + 1e-6
        });
    }

    pub fn flush(&mut self) {
        self.pending.clear();
        self.voices.clear();
        self.delay.iter_mut().for_each(|x| *x = 0.0);
        self.delay_idx = 0;
    }

    /// Cancel future notes while allowing voices already sounding to finish.
    pub fn clear_pending(&mut self) {
        self.pending.clear();
    }

    /// (live voices, pending-but-not-started events) — diagnostics.
    pub fn stats(&self) -> (usize, usize) {
        (self.voices.len(), self.pending.len())
    }

    pub fn diag1(&self) -> f64 {
        self.sched_calls as f64
    }

    pub fn diag2(&self) -> f64 {
        self.spawned_total as f64
    }

    pub fn diag3(&self) -> f64 {
        self.first_at
    }

    #[cfg(test)]
    pub fn active_voices(&self) -> usize {
        self.voices.len()
    }
}

fn soft_clip(x: f64) -> f64 {
    // NOTE: written defensively — a stray NaN must never become output
    // (f64::min(NaN, 1.0) == 1.0, which once turned silence into a DC 1.0).
    if !x.is_finite() {
        return 0.0;
    }
    let y = if x > 1.0 {
        2.0 / 3.0
    } else if x < -1.0 {
        -2.0 / 3.0
    } else {
        x - x * x * x / 3.0
    };
    y.min(1.0).max(-1.0)
}

/// Clamp with a fallback for NaN control values.
fn clamp_def(v: f64, lo: f64, hi: f64, def: f64) -> f64 {
    if v.is_finite() {
        v.clamp(lo, hi)
    } else {
        def
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::DEFAULTS;

    fn default_ctl() -> [f64; NCTL] {
        DEFAULTS
    }

    #[test]
    fn samples_play_at_requested_speed_and_end() {
        let mut d = Dsp::new(48000.0);
        assert!(!d.load_sample("bad", &[], 48000.0));
        assert!(d.load_sample("sample", &vec![0.5; 480], 48000.0));
        let mut ctl = default_ctl();
        ctl[CTL_SPEED] = 2.0;
        ctl[CTL_ATTACK] = 0.0001;
        ctl[CTL_CUTOFF] = 1000.0;
        d.schedule(0.0, 1.0, &ctl, "sample");
        let mut l = vec![0.0; 256];
        let mut r = vec![0.0; 256];
        d.process(&mut l, &mut r, 0);
        assert!(l[100].abs() > 0.01);
        for q in 1..20 { d.process(&mut l, &mut r, q * 256); }
        assert!(l.iter().all(|v| v.abs() < 0.0001));
        d.flush();
        d.schedule(0.0, 1.0, &ctl, "sample");
        d.process(&mut l, &mut r, 0);
        assert!(l[100].abs() > 0.01, "flush must preserve registered samples");
    }

    #[test]
    fn new_timbres_produce_finite_audio() {
        for sound in ["pulse", "organ", "tri"] {
            let mut d = Dsp::new(48000.0);
            d.schedule(0.0, 0.1, &default_ctl(), sound);
            let mut l = vec![0.0; 2048];
            let mut r = vec![0.0; 2048];
            d.process(&mut l, &mut r, 0);
            assert!(l.iter().all(|v| v.is_finite() && v.abs() <= 1.0));
            assert!(l.iter().any(|v| v.abs() > 0.01));
        }
    }

    #[test]
    fn renders_audio() {
        let mut d = Dsp::new(48000.0);
        let mut ctl = default_ctl();
        ctl[CTL_NOTE] = 60.0;
        d.schedule(0.0, 0.5, &ctl, "saw");
        let mut l = vec![0.0f32; 512];
        let mut r = vec![0.0f32; 512];
        let mut peak = 0.0f32;
        for q in 0..40 {
            d.process(&mut l, &mut r, (q * 512) as i64);
            for i in 0..512 {
                peak = peak.max(l[i].abs()).max(r[i].abs());
            }
        }
        assert!(peak > 0.01, "expected audible output, peak={peak}");
        assert!(peak <= 1.0);
    }

    #[test]
    fn future_notes_are_sample_accurate() {
        let mut d = Dsp::new(48000.0);
        let ctl = default_ctl();
        // starts at frame 512 exactly
        d.schedule(512.0 / 48000.0, 0.2, &ctl, "sine");
        let mut l = vec![0.0f32; 512];
        let mut r = vec![0.0f32; 512];
        d.process(&mut l, &mut r, 0);
        assert!(l.iter().all(|x| *x == 0.0), "first quantum must be silent");
        d.process(&mut l, &mut r, 512);
        let peak = l.iter().chain(r.iter()).fold(0.0f32, |a, b| a.max(b.abs()));
        assert!(peak > 0.001, "note should start in second quantum, peak={peak}");
    }

    #[test]
    fn drums_produce_impulse() {
        for sound in ["bd", "sn", "hh", "cp", "tom"] {
            let mut d = Dsp::new(48000.0);
            let ctl = default_ctl();
            d.schedule(0.0, 0.3, &ctl, sound);
            let mut l = vec![0.0f32; 256];
            let mut r = vec![0.0f32; 256];
            let mut peak = 0.0f32;
            for q in 0..200 {
                d.process(&mut l, &mut r, (q * 256) as i64);
                for i in 0..256 {
                    peak = peak.max(l[i].abs()).max(r[i].abs());
                }
            }
            assert!(peak > 0.005, "{sound} silent (peak={peak})");
        }
    }

    #[test]
    fn nan_controls_never_leak_to_output() {
        let mut d = Dsp::new(48000.0);
        let mut ctl = default_ctl();
        for c in ctl.iter_mut() {
            *c = f64::NAN; // hostile input: every slot NaN
        }
        d.schedule(0.0, 0.5, &ctl, "saw");
        let mut l = vec![0.0f32; 256];
        let mut r = vec![0.0f32; 256];
        for q in 0..100 {
            d.process(&mut l, &mut r, (q * 256) as i64);
            for i in 0..256 {
                assert!(l[i].is_finite() && r[i].is_finite(), "NaN in output");
                assert!(l[i].abs() <= 1.0);
            }
        }
    }

    #[test]
    fn flush_silences() {
        let mut d = Dsp::new(48000.0);
        let ctl = default_ctl();
        d.schedule(0.0, 1.0, &ctl, "saw");
        let mut l = vec![0.0f32; 256];
        let mut r = vec![0.0f32; 256];
        d.process(&mut l, &mut r, 0);
        d.flush();
        for q in 1..100 {
            d.process(&mut l, &mut r, (q * 256) as i64);
            assert!(l.iter().all(|x| *x == 0.0));
        }
    }

    #[test]
    fn clear_pending_keeps_current_voice() {
        let mut d = Dsp::new(48000.0);
        let ctl = default_ctl();
        d.schedule(0.0, 1.0, &ctl, "saw");
        d.schedule(0.5, 1.0, &ctl, "saw");
        let mut l = vec![0.0f32; 256];
        let mut r = vec![0.0f32; 256];
        d.process(&mut l, &mut r, 0);
        assert_eq!(d.stats(), (1, 1));
        d.clear_pending();
        assert_eq!(d.stats(), (1, 0));
        d.process(&mut l, &mut r, 256);
        assert!(l.iter().any(|sample| sample.abs() > 0.001));
    }
}
