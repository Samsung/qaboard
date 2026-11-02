//! Nanoseconds since the process started (monotonic): every timestamp of the run.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

static START: OnceLock<Instant> = OnceLock::new();

pub fn start() -> Instant {
    *START.get_or_init(Instant::now)
}

#[inline]
pub fn now() -> u64 {
    start().elapsed().as_nanos() as u64
}

/// Sleeps until `t` (ns since the start): the last stretch is a busy wait, so requests leave on time
pub fn sleep_until(t: u64) {
    loop {
        let n = now();
        if n >= t {
            return;
        }
        let ahead = t - n;
        if ahead > 150_000 {
            std::thread::sleep(Duration::from_nanos(ahead - 80_000));
        } else {
            std::hint::spin_loop();
        }
    }
}

/// Less precise, without the busy wait
pub fn sleep_until_lazy(t: u64) {
    let n = now();
    if t > n {
        std::thread::sleep(Duration::from_nanos(t - n));
    }
}
