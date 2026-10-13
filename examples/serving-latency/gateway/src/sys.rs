//! What Linux tells us about CPU use: per core (/proc/stat), per thread (/proc/self/task/<tid>/schedstat).
//! Elsewhere, these are empty.

use std::fs;

/// (busy, total) jiffies per core
pub fn cores() -> Vec<(u64, u64)> {
    let Ok(stat) = fs::read_to_string("/proc/stat") else { return vec![] };
    stat.lines()
        .filter(|l| l.starts_with("cpu") && l.as_bytes().get(3).is_some_and(|c| c.is_ascii_digit()))
        .map(|l| {
            let v: Vec<u64> = l.split_whitespace().skip(1).filter_map(|x| x.parse().ok()).collect();
            let total: u64 = v.iter().take(8).sum();
            let idle = v.get(3).copied().unwrap_or(0) + v.get(4).copied().unwrap_or(0);
            (total - idle, total)
        })
        .collect()
}

/// % busy per core between two readings
pub fn busy(before: &[(u64, u64)], after: &[(u64, u64)]) -> Vec<f64> {
    before
        .iter()
        .zip(after)
        .map(|(&(b0, t0), &(b1, t1))| if t1 > t0 { 100.0 * (b1 - b0) as f64 / (t1 - t0) as f64 } else { 0.0 })
        .collect()
}

/// CPU time of a thread of this process, ns
pub fn thread_cpu_ns(tid: i32) -> u64 {
    fs::read_to_string(format!("/proc/self/task/{tid}/schedstat"))
        .ok()
        .and_then(|s| s.split_whitespace().next().and_then(|v| v.parse().ok()))
        .unwrap_or(0)
}

pub fn cpu_count() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1)
}
