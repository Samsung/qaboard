//! CPU samples of all threads with pprof-rs during the measured window, as folded stacks
//! (`thread;outer::frame;...;inner::frame count`, Brendan Gregg's format). Names are stable from run to run:
//! demangled without their hash, thread names without their index (`worker-2` -> `worker`).

use std::collections::HashMap;

pub const FREQUENCY: i32 = 997;

/// Samples from the start of the repeat: starting the profiler (and the first unwinds) takes a while, so it starts
/// before the measured window, and only the samples taken in the window count (counts at the end - at the start).
pub struct Sampler {
    guard: Option<pprof::ProfilerGuard<'static>>,
    at_start: Option<pprof::UnresolvedReport>,
}

impl Sampler {
    pub fn start() -> Sampler {
        let guard = pprof::ProfilerGuardBuilder::default().frequency(FREQUENCY).build();
        if let Err(e) = &guard {
            println!("WARN cpu profiler unavailable: {e}");
        }
        Sampler { guard: guard.ok(), at_start: None }
    }

    fn counts(&self) -> Option<pprof::UnresolvedReport> {
        self.guard.as_ref().and_then(|g| g.report().build_unresolved().ok())
    }

    /// The measured window starts
    pub fn window_start(&mut self) {
        self.at_start = self.counts();
    }

    /// Stops sampling, returns folded stack -> samples in the window
    pub fn stop(mut self) -> HashMap<String, u64> {
        let Some(at_end) = self.counts() else { return HashMap::new() };
        self.guard.take();
        let mut folded = HashMap::new();
        for (frames, count) in at_end.data {
            let count = count - self.at_start.as_ref().and_then(|s| s.data.get(&frames)).copied().unwrap_or(0);
            if count <= 0 {
                continue;
            }
            let frames = pprof::Frames::from(frames);
            if let Some(line) = fold(&frames.thread_name, frames.frames.iter().map(|f| f.iter().map(|s| s.name()).collect())) {
                *folded.entry(line).or_insert(0) += count as u64;
            }
        }
        folded
    }
}

/// CPU time of the whole process (all threads), ns
pub fn process_cpu_ns() -> u64 {
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) };
    let tv = |t: libc::timeval| t.tv_sec as u64 * 1_000_000_000 + t.tv_usec as u64 * 1000;
    tv(usage.ru_utime) + tv(usage.ru_stime)
}

/// `worker-2` -> `worker`
pub fn thread_kind(name: &str) -> String {
    match name.rsplit_once('-') {
        Some((kind, index)) if !kind.is_empty() && index.chars().all(|c| c.is_ascii_digit()) => kind.to_string(),
        _ if name.is_empty() => "unnamed".into(),
        _ => name.to_string(),
    }
}

/// Without the symbol hash (`::h0123456789abcdef`) and crate disambiguators (`[1a2b3c]`)
pub fn clean_symbol(name: &str) -> String {
    let mut s = name.to_string();
    if let Some(i) = s.rfind("::h") {
        let hash = &s[i + 3..];
        if hash.len() == 16 && hash.chars().all(|c| c.is_ascii_hexdigit()) {
            s.truncate(i);
        }
    }
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '[' {
            let rest: String = chars.clone().take_while(|&c| c != ']').collect();
            if !rest.is_empty() && rest.chars().all(|c| c.is_ascii_hexdigit()) {
                for _ in 0..=rest.len() {
                    chars.next();
                }
                continue;
            }
        }
        out.push(c);
    }
    out.replace(';', ":")
}

fn is_sampler_frame(name: &str) -> bool {
    name.starts_with("pprof::") || name.starts_with("backtrace::") || name.contains("__restore_rt") || name == "Unknown"
        || name.starts_with("<pprof::") || name.starts_with("std::backtrace") || name.contains("perf_signal_handler")
}

/// One folded line from a sample's frames (innermost first, each frame with its inlined functions, innermost first)
pub fn fold(thread: &str, frames: impl Iterator<Item = Vec<String>>) -> Option<String> {
    let mut names: Vec<String> = frames.flat_map(|inlined| inlined.into_iter()).map(|n| clean_symbol(&n)).collect();
    // The innermost frames are the profiler's signal handler: they go, up to the interrupted function
    let handler = names.iter().take_while(|n| is_sampler_frame(n)).count();
    names.drain(..handler);
    for n in names.iter_mut().filter(|n| n.as_str() == "Unknown") {
        *n = "[unknown]".into();
    }
    // Outermost first, from our own code: no thread start boilerplate
    names.reverse();
    if let Some(first) = names.iter().position(|n| n.starts_with("gateway::")) {
        names.drain(..first);
    }
    // and without the closures that start our threads
    let boilerplate = names.iter().take_while(|n| n.contains("{closure") || n.starts_with("gateway::gateway::spawn")).count();
    names.drain(..boilerplate.min(names.len().saturating_sub(1)));
    if names.is_empty() {
        return None;
    }
    Some(format!("{};{}", thread_kind(thread), names.join(";")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert_eq!(thread_kind("worker-12"), "worker");
        assert_eq!(thread_kind("batcher"), "batcher");
        assert_eq!(clean_symbol("gateway::cache::Shared::get::h0123456789abcdef"), "gateway::cache::Shared::get");
        assert_eq!(clean_symbol("<lru[1a2b3c]::LruCache<u32, alloc[99ff]::vec::Vec<i16>>>::put"), "<lru::LruCache<u32, alloc::vec::Vec<i16>>>::put");
    }

    #[test]
    fn folds() {
        let frames = vec![
            vec!["backtrace::trace::h1111111111111111".to_string()],
            vec!["pprof::profiler::perf_signal_handler::h2222222222222222".to_string()],
            vec!["__restore_rt".to_string()],
            vec!["gateway::model::dot_i8".to_string(), "gateway::model::dense_int8".to_string()],
            vec!["gateway::gateway::worker".to_string()],
            vec!["std::sys::backtrace::__rust_begin_short_backtrace".to_string()],
            vec!["start_thread".to_string()],
        ];
        assert_eq!(
            fold("worker-1", frames.into_iter()).unwrap(),
            "worker;gateway::gateway::worker;gateway::model::dense_int8;gateway::model::dot_i8"
        );
    }
}
