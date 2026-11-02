//! A run: repeats of (fresh gateway, load generator), then what was measured. Each repeat has a warmup, then a
//! measured window: requests scheduled in the window count. Latency = completion time - *scheduled* send time.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::sync::atomic::Ordering;
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::thread;

use hdrhistogram::Histogram;

use crate::cache::Cache;
use crate::clock::{self, now};
use crate::gateway::{self, Config, Done, Live, Request};
use crate::json::Json;
use crate::load::{LoadSpec, Schedule, Scheduled};
use crate::model::{Model, D_IN};
use crate::profile::{self, Sampler};
use crate::rng::{mix, Rng};
use crate::sys;

const MS: f64 = 1e6;
const TICK: u64 = 100_000_000; // 100 ms
const POOL_TOKENS: usize = 4096;

pub struct RunSpec {
    pub gateway: Config,
    pub load: LoadSpec,
    pub dtype: crate::model::Dtype,
    pub seed: u64,
    pub repeats: usize,
    pub warmup_s: f64,
    pub duration_s: f64,
    pub profile: bool,
}

pub struct Repeat {
    pub seed: u64,
    pub schedule_window: (u64, u64),
    pub done: Vec<Done>,
    pub batches: Vec<(u64, u16)>,
    /// CPU time of the gateway's threads in the window
    pub cpu_ns: u64,
    /// When the CPU times were read: what was served between these two times cost cpu_ns
    pub cpu_window: (u64, u64),
    /// Shared cache: how long its lock was held in cpu_window (ns)
    pub lock_held_ns: Option<u64>,
    /// CPU time of the whole process in the window (with the load generator), for the samples' weights
    pub process_cpu_ns: u64,
    /// per 100 ms from the start of the repeat
    pub depth: Vec<u32>,
    pub cores: Vec<Vec<f64>>,
    pub folded: HashMap<String, u64>,
    pub steps: Vec<crate::load::Step>,
    pub bursts: Vec<(u64, u64)>,
    pub start: u64,
}

impl Repeat {
    /// Requests answered while the CPU time was measured: what it paid for. Under overload, requests scheduled in the
    /// window are answered after it, and their CPU time isn't in cpu_ns.
    pub fn served(&self) -> u64 {
        let (t0, t1) = self.cpu_window;
        self.done.iter().filter(|d| !d.dropped && d.t_done >= t0 && d.t_done < t1).count() as u64
    }

    /// Shared cache: the share of the measured window its lock was held
    pub fn lock_busy(&self) -> Option<f64> {
        let (t0, t1) = self.cpu_window;
        self.lock_held_ns.filter(|_| t1 > t0).map(|held| held as f64 / (t1 - t0) as f64)
    }
}

/// Token vectors payloads are made of: a request's tokens are rows picked from its key, so a key always has the same
/// payload (and the cache's answers are right)
fn token_pool(seed: u64) -> Arc<Vec<f32>> {
    let mut rng = Rng::new(mix(seed, 0x9001));
    Arc::new((0..POOL_TOKENS * D_IN).map(|_| rng.signed()).collect())
}

fn payload(pool: &[f32], key: u32, tokens: u16) -> Vec<f32> {
    let mut p = Vec::with_capacity(tokens as usize * D_IN);
    for i in 0..tokens as u64 {
        let row = (mix(key as u64, i) % POOL_TOKENS as u64) as usize;
        p.extend_from_slice(&pool[row * D_IN..(row + 1) * D_IN]);
    }
    p
}

fn loadgen(requests: Vec<Scheduled>, base: u64, deadline: u64, pool: Arc<Vec<f32>>, ingress: Vec<Sender<Request>>, live: Arc<Live>) {
    let n = ingress.len();
    for (i, s) in requests.into_iter().enumerate() {
        let t = base + s.t;
        clock::sleep_until(t);
        let r = Request {
            id: i as u32, key: s.key, tokens: s.tokens, t_sched: t, deadline: t + deadline, t_ingress: 0, t_queued: 0,
            lock_ns: 0, payload: payload(&pool, s.key, s.tokens),
        };
        live.sent.fetch_add(1, Ordering::Relaxed);
        if ingress[i % n].send(r).is_err() {
            break;
        }
    }
}

fn thousands(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

pub fn run_repeat(spec: &RunSpec, model: &Arc<Model>, pool: &Arc<Vec<f32>>, index: usize, cores: &[usize]) -> Repeat {
    let seed = mix(spec.seed, index as u64 + 1);
    let Schedule { requests, window, steps, bursts } = spec.load.schedule(seed, spec.warmup_s, spec.duration_s);
    let total = requests.len() as u64;
    let end = requests.last().map(|r| r.t).unwrap_or(0).max(window.1);
    let cfg = &spec.gateway;
    let cache = Arc::new(Cache::new(&cfg.cache, cfg.cache_entries, cfg.cache_shards, cfg.top_k));
    let live = Arc::new(Live::default());
    let running = gateway::start(cfg, model.clone(), cache.clone(), live.clone(), cores);
    let mut sampler = if spec.profile { Some(Sampler::start()) } else { None };
    let base = now() + 20_000_000;
    let loader = {
        let (pool, ingress, live) = (pool.clone(), running.ingress.clone(), live.clone());
        let deadline = cfg.deadline_ns;
        let core = if cfg.pin_workers { cores.first().copied() } else { None };
        thread::Builder::new()
            .name("loadgen".into())
            .spawn(move || {
                if let Some(core) = core {
                    core_affinity::set_for_current(core_affinity::CoreId { id: core });
                }
                loadgen(requests, base, deadline, pool, ingress, live)
            })
            .unwrap()
    };
    println!(
        "repeat {}: {} requests over {:.1}s ({:.1}s warmup), seed {:016x}",
        index + 1, thousands(total), end as f64 / 1e9, window.0 as f64 / 1e9, seed
    );

    // Every 100 ms: per-core CPU, queue depth, deadline misses
    let mut depth = vec![];
    let mut core_busy: Vec<Vec<f64>> = vec![];
    let mut last_cores = sys::cores();
    let mut folded = HashMap::new();
    let mut cpu_start = 0u64;
    let mut cpu_ns = 0u64;
    let mut cpu_window = (0u64, 0u64);
    let mut lock_held = (None, None);
    let mut process_start = 0u64;
    let mut process_cpu_ns = 0u64;
    let mut tick = 0u64;
    let mut in_burst = false;
    let drain_limit = base + end + 10_000_000_000;
    loop {
        tick += 1;
        let t = base + tick * TICK;
        clock::sleep_until_lazy(t);
        let elapsed = tick * TICK;
        let c = sys::cores();
        core_busy.push(sys::busy(&last_cores, &c));
        last_cores = c;
        let d = live.queue_depth_max.swap(0, Ordering::Relaxed);
        depth.push(d);
        let capacity = cfg.queue_capacity as u32;
        if d > capacity * 3 / 4 {
            println!("[{:6.2}s] WARN queue depth {} > {}", elapsed as f64 / 1e9, thousands(d as u64), thousands((capacity * 3 / 4) as u64));
        }
        let worst = live.worst_miss.swap(0, Ordering::Relaxed);
        let misses = live.misses.swap(0, Ordering::Relaxed);
        let late_ms = (worst >> 32) as f64 / 1000.0;
        if late_ms >= 10.0 {
            println!(
                "[{:6.2}s] ERROR request {} missed its deadline by {:.0} ms ({} misses in 100 ms)",
                elapsed as f64 / 1e9, worst & 0xffff_ffff, late_ms, misses
            );
        }
        let bursting = bursts.iter().any(|&(s, e)| elapsed >= s && elapsed < e);
        if bursting && !in_burst {
            println!("[{:6.2}s] INFO burst of requests", elapsed as f64 / 1e9);
        }
        in_burst = bursting;
        if elapsed >= window.0 && elapsed < window.1 && cpu_start == 0 {
            cpu_start = running.threads.iter().map(|&(_, tid)| sys::thread_cpu_ns(tid)).sum();
            cpu_window.0 = now();
            lock_held.0 = cache.lock_held_ns();
            process_start = profile::process_cpu_ns();
            if let Some(s) = sampler.as_mut() {
                s.window_start();
            }
        }
        if elapsed >= window.1 && cpu_ns == 0 && cpu_start > 0 {
            cpu_ns = running.threads.iter().map(|&(_, tid)| sys::thread_cpu_ns(tid)).sum::<u64>() - cpu_start;
            cpu_window.1 = now();
            lock_held.1 = cache.lock_held_ns();
            process_cpu_ns = profile::process_cpu_ns() - process_start;
            if let Some(s) = sampler.take() {
                folded = s.stop();
            }
        }
        let finished = live.completed.load(Ordering::Relaxed) + live.dropped.load(Ordering::Relaxed);
        let sent = live.sent.load(Ordering::Relaxed);
        if (elapsed >= end && sent == total && finished >= total) || now() > drain_limit {
            break;
        }
    }
    let _ = loader.join();
    let finished = running.stop();
    let sent = live.sent.load(Ordering::Relaxed);
    if sent < total {
        println!("WARN only {sent} of {total} requests were sent");
    }
    Repeat {
        seed, schedule_window: (base + window.0, base + window.1), done: finished.done, batches: finished.batches, cpu_ns,
        cpu_window, lock_held_ns: lock_held.1.zip(lock_held.0).map(|(end, start)| end - start), process_cpu_ns, depth,
        cores: core_busy, folded, steps, bursts, start: base,
    }
}

fn histogram() -> Histogram<u64> {
    Histogram::new_with_bounds(1, 60_000_000, 3).unwrap()
}

fn record(h: &mut Histogram<u64>, ns: u64) {
    h.saturating_record((ns / 1000).max(1));
}

fn ms(us: u64) -> f64 {
    us as f64 / 1000.0
}

pub const PERCENTILES: [f64; 5] = [50.0, 90.0, 99.0, 99.9, 99.99];

/// Averages of where the time went, around a percentile of latency
fn breakdown(sorted: &[&Done], percentile: f64) -> Json {
    let n = sorted.len();
    if n == 0 {
        return Json::Null;
    }
    let width = match percentile {
        p if p < 95.0 => 0.01,
        p if p < 99.5 => 0.002,
        _ => 0.0005,
    };
    let half = ((n as f64 * width / 2.0) as usize).max(2);
    let center = ((n as f64 * percentile / 100.0) as usize).min(n - 1);
    let lo = center.saturating_sub(half);
    let hi = (center + half + 1).min(n);
    let k = (hi - lo) as f64;
    let avg = |f: fn(&Done) -> u64| sorted[lo..hi].iter().map(|d| f(d) as f64).sum::<f64>() / k / MS;
    Json::obj([
        ("percentile", Json::Num(percentile)),
        ("latency_ms", Json::Num(avg(|d| d.latency()))),
        ("queue_ms", Json::Num(avg(|d| d.queue))),
        ("batch_ms", Json::Num(avg(|d| d.batch))),
        ("lock_ms", Json::Num(avg(|d| d.lock))),
        ("compute_ms", Json::Num(avg(|d| d.compute))),
        ("requests", Json::Num(k)),
    ])
}

pub struct Summary {
    pub json: Json,
    pub latency: Histogram<u64>,
    pub p99_ms: f64,
}

pub fn summarize(r: &Repeat, deadline: u64) -> Summary {
    let (w0, w1) = r.schedule_window;
    let window_s = (w1 - w0) as f64 / 1e9;
    let in_window: Vec<&Done> = r.done.iter().filter(|d| d.t_sched >= w0 && d.t_sched < w1).collect();
    let sent = in_window.len() as f64;
    let mut completed: Vec<&Done> = in_window.iter().copied().filter(|d| !d.dropped).collect();
    completed.sort_by_key(|d| d.latency());
    let dropped = sent - completed.len() as f64;
    let on_time = completed.iter().filter(|d| d.latency() <= deadline).count() as f64;
    let hits = completed.iter().filter(|d| d.hit).count() as f64;
    let mut latency = histogram();
    let mut lock = histogram();
    for d in &completed {
        record(&mut latency, d.latency());
        record(&mut lock, d.lock);
    }
    let pct: Vec<(String, Json)> = PERCENTILES
        .iter()
        .map(|&p| (format!("{p}"), Json::Num(ms(latency.value_at_quantile(p / 100.0)))))
        .chain([("max".to_string(), Json::Num(ms(latency.max())))])
        .collect();
    let batches: Vec<u16> = r.batches.iter().filter(|(t, _)| *t >= w0 && *t < w1 + 2_000_000_000).map(|&(_, s)| s).collect();
    let batch_mean = if batches.is_empty() { 0.0 } else { batches.iter().map(|&s| s as f64).sum::<f64>() / batches.len() as f64 };

    // Per 100 ms of scheduled time, over the whole repeat
    let buckets = r.depth.len();
    let mut per_bucket: Vec<Vec<u64>> = vec![vec![]; buckets];
    for d in r.done.iter().filter(|d| !d.dropped) {
        let b = ((d.t_sched - r.start) / TICK) as usize;
        if b < buckets {
            per_bucket[b].push(d.latency());
        }
    }
    let q = |v: &mut Vec<u64>, p: f64| -> f64 {
        if v.is_empty() {
            return f64::NAN;
        }
        v.sort_unstable();
        v[((v.len() - 1) as f64 * p).round() as usize] as f64 / MS
    };
    let timeline = Json::obj([
        ("t_s", Json::nums((0..buckets).map(|b| (b as f64 + 0.5) * 0.1))),
        ("p50_ms", Json::nums(per_bucket.iter_mut().map(|v| q(v, 0.5)))),
        ("p99_ms", Json::nums(per_bucket.iter_mut().map(|v| q(v, 0.99)))),
        ("max_ms", Json::nums(per_bucket.iter_mut().map(|v| q(v, 1.0)))),
        ("queue_depth", Json::nums(r.depth.iter().map(|&d| d as f64))),
        ("window_s", Json::nums([(w0 - r.start) as f64 / 1e9, (w1 - r.start) as f64 / 1e9])),
        ("bursts_s", Json::Arr(r.bursts.iter().map(|&(s, e)| Json::nums([s as f64 / 1e9, e as f64 / 1e9])).collect())),
    ]);
    let cores = Json::obj([
        ("t_s", Json::nums((0..r.cores.len()).map(|b| (b as f64 + 0.5) * 0.1))),
        ("busy", Json::Arr((0..r.cores.first().map_or(0, |c| c.len())).map(|c| Json::nums(r.cores.iter().map(|row| row[c]))).collect())),
    ]);
    let steps = Json::Arr(
        r.steps
            .iter()
            .map(|s| {
                let (s0, s1) = (r.start + s.start, r.start + s.end);
                let mut lat: Vec<u64> = r.done.iter().filter(|d| d.t_sched >= s0 && d.t_sched < s1 && !d.dropped).map(|d| d.latency()).collect();
                let all = r.done.iter().filter(|d| d.t_sched >= s0 && d.t_sched < s1).count();
                let secs = (s1 - s0) as f64 / 1e9;
                let completed = lat.len();
                Json::obj([
                    ("rate", Json::Num(s.rate)),
                    ("offered", Json::Num(all as f64 / secs)),
                    ("throughput", Json::Num(completed as f64 / secs)),
                    ("p50_ms", Json::Num(q(&mut lat, 0.5))),
                    ("p99_ms", Json::Num(q(&mut lat, 0.99))),
                    ("dropped", Json::Num((all - completed) as f64 / all.max(1) as f64)),
                ])
            })
            .collect(),
    );
    let p99_ms = ms(latency.value_at_quantile(0.99));
    let json = Json::obj([
        ("seed", Json::Str(format!("{:016x}", r.seed))),
        ("window_s", Json::Num(window_s)),
        ("sent", Json::Num(sent)),
        ("completed", Json::Num(completed.len() as f64)),
        ("dropped", Json::Num(dropped)),
        ("hits", Json::Num(hits)),
        ("throughput", Json::Num(completed.len() as f64 / window_s)),
        ("goodput", Json::Num(on_time / window_s)),
        ("slo_miss", Json::Num(if sent > 0.0 { (sent - on_time) / sent } else { 0.0 })),
        ("dropped_share", Json::Num(if sent > 0.0 { dropped / sent } else { 0.0 })),
        ("cache_hit", Json::Num(if completed.is_empty() { 0.0 } else { hits / completed.len() as f64 })),
        ("cpu_s", Json::Num(r.cpu_ns as f64 / 1e9)),
        ("cpu_per_req_us", Json::Num(match r.served() { 0 => 0.0, served => r.cpu_ns as f64 / 1e3 / served as f64 })),
        ("lock_busy", r.lock_busy().map_or(Json::Null, Json::Num)),
        ("percentiles_ms", Json::obj(pct)),
        ("lock_wait_p99_ms", Json::Num(ms(lock.value_at_quantile(0.99)))),
        ("batch_mean", Json::Num(batch_mean)),
        ("batches", Json::Num(batches.len() as f64)),
        ("breakdown", Json::Arr([50.0, 90.0, 99.0, 99.9].iter().map(|&p| breakdown(&completed, p)).collect())),
        ("timeline", timeline),
        ("cores", cores),
        ("steps", steps),
    ]);
    Summary { json, latency, p99_ms }
}

/// HdrHistogram's percentile distribution, in ms (like Java's outputPercentileDistribution)
pub fn percentile_text(h: &Histogram<u64>) -> String {
    let mut s = String::new();
    writeln!(s, "{:>12} {:>14} {:>10} {:>14}\n", "Value", "Percentile", "TotalCount", "1/(1-Percentile)").unwrap();
    for v in h.iter_quantiles(5) {
        let q = v.quantile_iterated_to();
        let inv = if q < 1.0 { format!("{:14.2}", 1.0 / (1.0 - q)) } else { String::new() };
        writeln!(s, "{:12.3} {:14.12} {:10} {}", ms(v.value_iterated_to()), q, v.count_since_last_iteration(), inv).unwrap();
    }
    writeln!(s, "#[Mean    = {:12.3}, StdDeviation   = {:12.3}]", h.mean() / 1000.0, h.stdev() / 1000.0).unwrap();
    writeln!(s, "#[Max     = {:12.3}, Total count    = {:12}]", ms(h.max()), h.len()).unwrap();
    s
}

pub struct Outcome {
    pub json: Json,
    pub folded: HashMap<String, u64>,
    pub percentiles: String,
}

pub fn run(spec: &RunSpec, model: Arc<Model>, cores: &[usize]) -> Outcome {
    let pool = token_pool(spec.seed);
    let mut summaries = vec![];
    let mut repeats = vec![];
    let mut folded: HashMap<String, u64> = HashMap::new();
    let mut batch_sizes: Vec<u64> = vec![0; spec.gateway.max_batch.max(1) + 1];
    let mut requests_profiled = 0u64;
    let mut cpu_ns = 0u64;
    let mut process_cpu_ns = 0u64;
    for i in 0..spec.repeats {
        let r = run_repeat(spec, &model, &pool, i, cores);
        let s = summarize(&r, spec.gateway.deadline_ns);
        let (w0, w1) = r.schedule_window;
        let served = r.served();
        requests_profiled += served;
        cpu_ns += r.cpu_ns;
        process_cpu_ns += r.process_cpu_ns;
        for (k, v) in &r.folded {
            *folded.entry(k.clone()).or_insert(0) += v;
        }
        for &(t, size) in &r.batches {
            if t >= w0 && t < w1 + 2_000_000_000 {
                let size = size as usize;
                if size >= batch_sizes.len() {
                    batch_sizes.resize(size + 1, 0);
                }
                batch_sizes[size] += 1;
            }
        }
        println!(
            "repeat {}: p50 {:.2} ms, p99 {:.2} ms, p99.9 {:.2} ms, max {:.2} ms | {:.0} req/s, cpu {:.0} us/req{}",
            i + 1,
            ms(s.latency.value_at_quantile(0.5)), s.p99_ms, ms(s.latency.value_at_quantile(0.999)), ms(s.latency.max()),
            s.latency.len() as f64 / ((w1 - w0) as f64 / 1e9),
            if served > 0 { r.cpu_ns as f64 / 1e3 / served as f64 } else { 0.0 },
            r.lock_busy().map(|busy| format!(", cache lock held {:.0}% of the time", busy * 100.0)).unwrap_or_default(),
        );
        summaries.push(s);
        repeats.push(r.seed);
    }
    let mut pooled = histogram();
    for s in &summaries {
        pooled.add(&s.latency).unwrap();
    }
    // The CDF on a log tail: one point per percentile step, up to the max
    let cdf: Vec<Json> = pooled
        .iter_quantiles(10)
        .map(|v| Json::nums([v.quantile_iterated_to() * 100.0, ms(v.value_iterated_to())]))
        .collect();
    // Log-spaced histogram: 10 bins per decade from 10 µs
    let mut bins: Vec<(f64, f64, u64)> = vec![];
    let mut lo = 10.0f64;
    while lo < (pooled.max() as f64).max(10.0) {
        let hi = lo * 10f64.powf(0.1);
        let count = pooled.count_between(lo as u64, (hi as u64).saturating_sub(1).max(lo as u64));
        bins.push((lo / 1000.0, hi / 1000.0, count));
        lo = hi;
    }
    let order: Vec<usize> = {
        let mut idx: Vec<usize> = (0..summaries.len()).collect();
        idx.sort_by(|&a, &b| summaries[a].p99_ms.partial_cmp(&summaries[b].p99_ms).unwrap());
        idx
    };
    let json = Json::obj([
        ("allocator", Json::from(crate::alloc::name())),
        ("cpus", Json::from(sys::cpu_count())),
        ("profile_frequency", Json::Num(profile::FREQUENCY as f64)),
        ("profiled_requests", Json::Num(requests_profiled as f64)),
        ("cpu_s", Json::Num(cpu_ns as f64 / 1e9)),
        ("profiled_cpu_s", Json::Num(process_cpu_ns as f64 / 1e9)),
        ("profiled_samples", Json::Num(folded.values().sum::<u64>() as f64)),
        ("median_repeat", Json::Num(order[order.len() / 2] as f64)),
        ("repeats", Json::Arr(summaries.into_iter().map(|s| s.json).collect())),
        ("cdf", Json::Arr(cdf)),
        ("histogram", Json::Arr(bins.into_iter().map(|(a, b, c)| Json::nums([a, b, c as f64])).collect())),
        ("batch_sizes", Json::nums(batch_sizes.iter().map(|&c| c as f64))),
    ]);
    let _ = repeats;
    Outcome { json, folded, percentiles: percentile_text(&pooled) }
}
