//! Generation-checked handle table. Handles handed across the FFI boundary are
//! opaque ids rather than raw pointers, so a stale, forged or double-freed
//! handle is rejected instead of dereferenced.

use std::sync::Mutex;

struct Slot<T> {
    gen: u16,
    val: Option<Box<T>>,
}

pub struct Registry<T> {
    slots: Mutex<Vec<Slot<T>>>,
}

impl<T> Registry<T> {
    pub const fn new() -> Self {
        Registry {
            slots: Mutex::new(Vec::new()),
        }
    }

    /// Store `v`; returns a positive handle (`gen << 16 | index + 1`), or 0 when full.
    pub fn insert(&self, v: T) -> i32 {
        let Ok(mut slots) = self.slots.lock() else {
            return 0;
        };
        let idx = match slots.iter().position(|s| s.val.is_none()) {
            Some(i) => i,
            None if slots.len() < 0xffff => {
                slots.push(Slot { gen: 0, val: None });
                slots.len() - 1
            }
            None => return 0,
        };
        let s = &mut slots[idx];
        s.gen = if s.gen >= 0x7fff { 1 } else { s.gen + 1 };
        s.val = Some(Box::new(v));
        ((s.gen as i32) << 16) | (idx as i32 + 1)
    }

    fn locate(h: i32) -> Option<(usize, u16)> {
        if h <= 0 {
            return None;
        }
        let idx = (h & 0xffff) as usize;
        (idx != 0).then(|| (idx - 1, (h >> 16) as u16))
    }

    /// Stable pointer to the value (boxed, so it survives table growth), or
    /// null for an unknown/stale handle.
    pub fn ptr(&self, h: i32) -> *mut T {
        let (Some((idx, gen)), Ok(mut slots)) = (Self::locate(h), self.slots.lock()) else {
            return std::ptr::null_mut();
        };
        match slots.get_mut(idx) {
            Some(s) if s.gen == gen => s
                .val
                .as_deref_mut()
                .map_or(std::ptr::null_mut(), |b| b as *mut T),
            _ => std::ptr::null_mut(),
        }
    }

    /// Drop the value. Returns false for an unknown/stale handle.
    pub fn remove(&self, h: i32) -> bool {
        let (Some((idx, gen)), Ok(mut slots)) = (Self::locate(h), self.slots.lock()) else {
            return false;
        };
        match slots.get_mut(idx) {
            Some(s) if s.gen == gen => s.val.take().is_some(),
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_and_forged_handles_are_rejected() {
        let r: Registry<u32> = Registry::new();
        let a = r.insert(7);
        assert!(a > 0);
        assert_eq!(unsafe { *r.ptr(a) }, 7);
        assert!(r.remove(a));
        assert!(r.ptr(a).is_null());
        assert!(!r.remove(a)); // double free
        let b = r.insert(9); // slot reused with a new generation
        assert_ne!(a, b);
        assert!(r.ptr(a).is_null());
        assert_eq!(unsafe { *r.ptr(b) }, 9);
        for bad in [0, -1, 12345, i32::MAX] {
            assert!(r.ptr(bad).is_null());
            assert!(!r.remove(bad));
        }
    }
}
