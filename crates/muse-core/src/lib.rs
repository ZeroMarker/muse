//! muse-core: Pattern IR, query engine, clock/scheduler and DSP engine.
//!
//! The binary crosses the WASM boundary twice:
//!  * main thread:  `ir_*` / `sched_*` — decode the pattern IR produced by the
//!    TypeScript DSL, run the clock + lookahead scheduler.
//!  * audio worklet: `dsp_*` — sample-accurate voice rendering.

mod dsp;
mod ir;
mod pattern;
mod sched;

pub use ir::{Pat, NCTL, DEFAULTS};

use std::sync::Mutex;

static LAST_ERR: Mutex<String> = Mutex::new(String::new());

fn set_err(msg: impl Into<String>) {
    if let Ok(mut e) = LAST_ERR.lock() {
        *e = msg.into();
    }
}

// ---------------------------------------------------------------------------
// shared memory helpers
// ---------------------------------------------------------------------------

/// Allocate `len` bytes in wasm linear memory for the JS side to fill.
#[no_mangle]
pub extern "C" fn muse_alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return std::ptr::null_mut();
    }
    let mut v: Vec<u8> = Vec::with_capacity(len);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// Free a buffer returned by [`muse_alloc`].
///
/// # Safety
/// `ptr`/`len` must come from a matching `muse_alloc(len)` call.
#[no_mangle]
pub unsafe extern "C" fn muse_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() && len > 0 {
        drop(Vec::from_raw_parts(ptr, 0, len));
    }
}

#[no_mangle]
pub extern "C" fn err_len() -> u32 {
    LAST_ERR.lock().map(|e| e.len() as u32).unwrap_or(0)
}

/// Copy the last error message into `out` (allocated with `muse_alloc`).
/// Returns the number of bytes written.
///
/// # Safety
/// `out` must point to at least `err_len()` writable bytes.
#[no_mangle]
pub unsafe extern "C" fn err_copy(out: *mut u8) -> u32 {
    let Ok(e) = LAST_ERR.lock() else { return 0 };
    let n = e.len().min(u32::MAX as usize) as u32;
    if !out.is_null() && n > 0 {
        std::ptr::copy_nonoverlapping(e.as_ptr(), out, n as usize);
    }
    n
}

// ---------------------------------------------------------------------------
// IR boundary
// ---------------------------------------------------------------------------

/// Decode a pattern IR buffer (see `web/src/ir.ts` for the wire format).
/// Returns a handle, or `0` on error (see `err_len`/`err_copy`).
///
/// # Safety
/// `ptr` must reference `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn ir_decode(ptr: *const u8, len: u32) -> i32 {
    let bytes = if ptr.is_null() || len == 0 {
        &[][..]
    } else {
        std::slice::from_raw_parts(ptr, len as usize)
    };
    match ir::decode(bytes) {
        Ok(pat) => Box::into_raw(Box::new(pat)) as i32,
        Err(e) => {
            set_err(format!("ir decode: {e}"));
            0
        }
    }
}

/// Release a pattern handle.
///
/// # Safety
/// `h` must be a live handle from [`ir_decode`].
#[no_mangle]
pub unsafe extern "C" fn ir_release(h: i32) {
    if h != 0 {
        drop(Box::from_raw(h as *mut Pat));
    }
}

// ---------------------------------------------------------------------------
// scheduler boundary (main thread)
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn sched_new(cps: f64) -> i32 {
    Box::into_raw(Box::new(sched::Sched::new(if cps > 0.0 { cps } else { 1.0 }))) as i32
}

/// # Safety
/// Handles must be live.
#[no_mangle]
pub unsafe extern "C" fn sched_set_pattern(sched_h: i32, pat_h: i32) -> i32 {
    if sched_h == 0 || pat_h == 0 {
        set_err("sched_set_pattern: null handle");
        return 0;
    }
    let s = &mut *(sched_h as *mut sched::Sched);
    let p = &*(pat_h as *const Pat);
    s.pat = Some(p.clone());
    1
}

#[no_mangle]
pub unsafe extern "C" fn sched_clear_pattern(sched_h: i32) {
    if sched_h != 0 {
        (*(sched_h as *mut sched::Sched)).pat = None;
    }
}

/// Change tempo, rebasing the clock at `audio_now` (audio-context seconds).
#[no_mangle]
pub unsafe extern "C" fn sched_set_cps(sched_h: i32, cps: f64, audio_now: f64) {
    if sched_h != 0 && cps > 0.0 {
        (*(sched_h as *mut sched::Sched)).set_cps(cps, audio_now);
    }
}

/// Cycle position at audio-context time `audio_now`.
#[no_mangle]
pub unsafe extern "C" fn sched_cycle_at(sched_h: i32, audio_now: f64) -> f64 {
    if sched_h == 0 {
        return 0.0;
    }
    (*(sched_h as *const sched::Sched)).cycle_at(audio_now)
}

/// Audio-context time of a cycle position (inverse of [`sched_cycle_at`]).
#[no_mangle]
pub unsafe extern "C" fn sched_audio_at(sched_h: i32, cycle: f64) -> f64 {
    if sched_h == 0 {
        return 0.0;
    }
    (*(sched_h as *const sched::Sched)).audio_at(cycle)
}

/// Restart the scheduling cursor at the current cycle (play / pattern swap).
#[no_mangle]
pub unsafe extern "C" fn sched_reset(sched_h: i32, audio_now: f64) {
    if sched_h != 0 {
        (*(sched_h as *mut sched::Sched)).reset(audio_now);
    }
}

/// Count events with onset in the un-scheduled window `[cursor, horizon)`.
#[no_mangle]
pub unsafe extern "C" fn sched_count(sched_h: i32, horizon: f64) -> i32 {
    if sched_h == 0 {
        return -1;
    }
    (*(sched_h as *mut sched::Sched)).count(horizon) as i32
}

/// Pack events from `[cursor, horizon)` into `out` (see `sched.rs` for the
/// record layout), advancing the cursor. Returns bytes written, or a negative
/// error code (`-1` bad handle, `-2` buffer too small).
///
/// # Safety
/// `out` must reference `cap` writable bytes.
#[no_mangle]
pub unsafe extern "C" fn sched_query(sched_h: i32, horizon: f64, out: *mut u8, cap: u32) -> i32 {
    if sched_h == 0 {
        return -1;
    }
    let s = &mut *(sched_h as *mut sched::Sched);
    let buf = std::slice::from_raw_parts_mut(out, cap as usize);
    match s.query(horizon, buf) {
        Ok(n) => n as i32,
        Err(_) => -2,
    }
}

/// Same as [`sched_query`] but without advancing the cursor (peek).
///
/// # Safety
/// `out` must reference `cap` writable bytes.
#[no_mangle]
pub unsafe extern "C" fn sched_peek(
    sched_h: i32,
    lo: f64,
    hi: f64,
    out: *mut u8,
    cap: u32,
) -> i32 {
    if sched_h == 0 {
        return -1;
    }
    let s = &*(sched_h as *const sched::Sched);
    let buf = std::slice::from_raw_parts_mut(out, cap as usize);
    match s.pack_range(lo, hi, buf) {
        Ok(n) => n as i32,
        Err(_) => -2,
    }
}

/// # Safety
/// `h` must be a live handle from [`sched_new`].
#[no_mangle]
pub unsafe extern "C" fn sched_free(h: i32) {
    if h != 0 {
        drop(Box::from_raw(h as *mut sched::Sched));
    }
}

// ---------------------------------------------------------------------------
// DSP boundary (audio worklet)
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn dsp_new(sample_rate: f64) -> i32 {
    Box::into_raw(Box::new(dsp::Dsp::new(sample_rate))) as i32
}

/// Schedule a note at absolute time `at_sec` (audio-context seconds).
///
/// # Safety
/// `ctl` must point to 12 `f64`s, `sound` to `sound_len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn dsp_schedule(
    h: i32,
    at_sec: f64,
    dur_sec: f64,
    ctl: *const f64,
    sound: *const u8,
    sound_len: u32,
) -> i32 {
    if h == 0 || ctl.is_null() {
        return 0;
    }
    let d = &mut *(h as *mut dsp::Dsp);
    let mut params = [0.0; ir::NCTL];
    params.copy_from_slice(std::slice::from_raw_parts(ctl, ir::NCTL));
    let name = if sound.is_null() || sound_len == 0 {
        String::new()
    } else {
        String::from_utf8_lossy(std::slice::from_raw_parts(sound, sound_len as usize)).into_owned()
    };
    d.schedule(at_sec, dur_sec, &params, &name);
    1
}

/// Render `n` stereo frames. `base_frame` is the absolute sample frame of the
/// first output sample of this quantum.
///
/// # Safety
/// `l`/`r` must reference `n` writable `f32`s.
#[no_mangle]
pub unsafe extern "C" fn dsp_process(h: i32, l: *mut f32, r: *mut f32, n: i32, base_frame: f64) {
    if h == 0 || n <= 0 {
        return;
    }
    let d = &mut *(h as *mut dsp::Dsp);
    let left = std::slice::from_raw_parts_mut(l, n as usize);
    let right = std::slice::from_raw_parts_mut(r, n as usize);
    d.process(left, right, base_frame as i64);
}

/// Diagnostics: `(voices << 16) | pending`.
#[no_mangle]
pub unsafe extern "C" fn dsp_stats(h: i32) -> u32 {
    if h == 0 {
        return 0;
    }
    let d = &*(h as *const dsp::Dsp);
    let (v, p) = d.stats();
    (((v.min(0xffff) as u32) << 16) | (p.min(0xffff) as u32))
}

/// Diagnostics pack: sched_calls (f64 bits via separate calls instead).
#[no_mangle]
pub unsafe extern "C" fn dsp_sched_calls(h: i32) -> u32 {
    if h == 0 {
        return 0;
    }
    (*(h as *const dsp::Dsp)).sched_calls
}

#[no_mangle]
pub unsafe extern "C" fn dsp_spawned(h: i32) -> u32 {
    if h == 0 {
        return 0;
    }
    (*(h as *const dsp::Dsp)).spawned_total
}

#[no_mangle]
pub unsafe extern "C" fn dsp_first_at(h: i32) -> f64 {
    if h == 0 {
        return f64::NAN;
    }
    (*(h as *const dsp::Dsp)).first_at
}

/// Kill all pending events, voices and delay tails (transport stop).
#[no_mangle]
pub unsafe extern "C" fn dsp_flush(h: i32) {
    if h != 0 {
        (*(h as *mut dsp::Dsp)).flush();
    }
}

/// Cancel pending notes without stopping voices already sounding.
#[no_mangle]
pub unsafe extern "C" fn dsp_clear_pending(h: i32) {
    if h != 0 {
        (*(h as *mut dsp::Dsp)).clear_pending();
    }
}

/// # Safety
/// `h` must be a live handle from [`dsp_new`].
#[no_mangle]
pub unsafe extern "C" fn dsp_free(h: i32) {
    if h != 0 {
        drop(Box::from_raw(h as *mut dsp::Dsp));
    }
}

/// Register mono PCM, copied into the DSP. Returns 1 on success.
/// # Safety
/// All pointers must refer to valid slices, and `h` must be a live DSP handle.
#[no_mangle]
pub unsafe extern "C" fn dsp_load_sample(h: i32, name: *const u8, name_len: i32, data: *const f32, frames: i32, rate: f64) -> i32 {
    if h == 0 || name.is_null() || data.is_null() || name_len <= 0 || name_len > 127 || frames <= 0 {
        return 0;
    }
    let Ok(name) = std::str::from_utf8(std::slice::from_raw_parts(name, name_len as usize)) else { return 0; };
    let samples = std::slice::from_raw_parts(data, frames as usize);
    (*(h as *mut dsp::Dsp)).load_sample(name, samples, rate) as i32
}
