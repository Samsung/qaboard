//! Kitefin's inference gateway and an open-loop load generator in one process, connected by in-memory channels.
//! `gateway-bench` (`cli()`) runs a load profile against the gateway a few times and writes what it measured:
//!
//!   gateway-bench --out DIR [--seed N] [--repeats 2] [--warmup 1] [--duration 3] [--no-profile] [key=value ...]
//!   gateway-bench --calibrate       # sizes the model and the responses for this machine, see calibrate.rs
//!
//! key=value: the gateway's flags (workers=3 cache=sharded...) and the load (arrivals=poisson rate=6000...), see
//! `gateway-bench --help`. The allocator comes from $GATEWAY_ALLOCATOR (system, jemalloc, mimalloc).
//! Files: DIR/bench.json (metrics, plots' data), DIR/cpu.folded (CPU samples), DIR/percentiles.txt.

pub mod alloc;
pub mod batcher;
pub mod bench;
pub mod cache;
pub mod calibrate;
pub mod clock;
pub mod gateway;
pub mod json;
pub mod load;
pub mod model;
pub mod profile;
pub mod response;
pub mod rng;
pub mod sys;

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

const HELP: &str = "\
gateway-bench --out DIR [--seed N] [--repeats N] [--warmup S] [--duration S] [--no-profile] [key=value ...]
gateway-bench --calibrate    prints the hidden= and top_k= that size requests for this machine (JSON)

Gateway (defaults: the head of main)
  workers=3               worker threads (the load generator keeps a core)
  batching=dynamic        none | dynamic
  max_batch=16            requests per batch, at most
  max_delay_us=250        a batch closes this long after it opened, if not full
  queue_policy=edf        fifo | lifo | edf | drop-late
  queue_capacity=4096
  pin=workers             none | workers (workers on cores 1-3, the load generator on 0)
  model_dtype=int8        fp32 | int8
  cache=sharded           none | shared | sharded
  cache_entries=16384  cache_shards=16
  batch_buffer=reuse      alloc | reuse
  payload_copy=false      copy payloads into the batch buffer instead of borrowing them
  bug_batch_overflow=false
  ingress_threads=2  deadline_ms=12
  hidden=1024             the model's hidden layer (a multiple of 64)
  top_k=64                outputs per token in a response
Load
  arrivals=poisson        poisson | bursty | ramp
  rate=6000               requests/s (ramp: of the `high` level)
  burst_factor=5 burst_ms=200 burst_every_ms=2000
  ramp_from=0.2 ramp_to=1.2 ramp_steps=10 ramp_step_ms=500
  tokens=fixed tokens_n=8 | tokens=pareto tokens_alpha=1.3 tokens_min=1 tokens_max=256
  zipf_s=0.8 keys=100000
";

pub fn cli() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--help" || a == "-h") || args.is_empty() {
        print!("{HELP}");
        return;
    }
    let mut out = None;
    let mut seed = 1u64;
    let mut repeats = 2usize;
    let mut warmup = 1.0f64;
    let mut duration = 3.0f64;
    let mut profile = true;
    let mut kv: BTreeMap<String, String> = BTreeMap::new();
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        let mut value = |name: &str| it.next().unwrap_or_else(|| fail(&format!("{name} needs a value")));
        match a.as_str() {
            "--out" => out = Some(PathBuf::from(value("--out"))),
            "--seed" => seed = value("--seed").parse().unwrap_or_else(|_| fail("--seed: an integer")),
            "--repeats" => repeats = value("--repeats").parse().unwrap_or_else(|_| fail("--repeats: an integer")),
            "--warmup" => warmup = value("--warmup").parse().unwrap_or_else(|_| fail("--warmup: seconds")),
            "--duration" => duration = value("--duration").parse().unwrap_or_else(|_| fail("--duration: seconds")),
            "--no-profile" => profile = false,
            "--calibrate" => {
                println!("{}", calibrate::run());
                return;
            }
            _ => match a.split_once('=') {
                Some((k, v)) => {
                    kv.insert(k.to_string(), v.to_string());
                }
                None => fail(&format!("unknown argument {a}")),
            },
        }
    }
    let out = out.unwrap_or_else(|| fail("--out DIR is required"));
    std::fs::create_dir_all(&out).unwrap_or_else(|e| fail(&format!("{}: {e}", out.display())));
    let mut settings = Settings(kv);
    let spec = settings.run_spec(seed, repeats, warmup, duration, profile);
    settings.unknown();

    let cpus = sys::cpu_count();
    let cores: Vec<usize> = core_affinity::get_core_ids().unwrap_or_default().into_iter().map(|c| c.id).collect();
    let mut spec = spec;
    if spec.gateway.pin_workers && cores.len() < spec.gateway.workers + 1 {
        println!("WARN pin=workers needs {} cores, this machine has {}: not pinning", spec.gateway.workers + 1, cores.len());
        spec.gateway.pin_workers = false;
    }
    let g = &spec.gateway;
    if !g.hidden.is_multiple_of(model::HIDDEN_STEP) {
        fail(&format!("hidden={}: a multiple of {}", g.hidden, model::HIDDEN_STEP));
    }
    let batching = if g.dynamic_batching { format!("dynamic batching (up to {} requests, {} us)", g.max_batch, g.max_delay_ns / 1000) } else { "no batching".into() };
    let cache = match g.cache.as_str() {
        "none" => "no cache".to_string(),
        "sharded" => format!("sharded cache ({} entries, {} shards)", g.cache_entries, g.cache_shards),
        kind => format!("{kind} cache ({} entries)", g.cache_entries),
    };
    println!(
        "gateway {}: {} workers{}, {batching}, {} queue ({}), {cache}, {} model {}-{}-{}, top {} outputs per token, {} allocator",
        env!("CARGO_PKG_VERSION"), g.workers, if g.pin_workers { " (pinned)" } else { "" }, format!("{:?}", g.policy).to_lowercase(),
        g.queue_capacity, if spec.dtype == model::Dtype::Int8 { "int8" } else { "fp32" }, model::D_IN, g.hidden, model::D_OUT, g.top_k,
        alloc::name(),
    );
    let load = &spec.load;
    let arrivals = match load.arrivals {
        load::Arrivals::Poisson => format!("Poisson arrivals at {} req/s", load.rate),
        load::Arrivals::Bursty { factor, burst_ms, every_ms } => format!("{} req/s on average, {factor}x for {burst_ms} ms every {every_ms} ms", load.rate),
        load::Arrivals::Ramp { from, to, steps, step_ms } => format!("{from} to {to} x {} req/s in {steps} steps of {step_ms} ms", load.rate),
    };
    let tokens = match load.tokens {
        load::Tokens::Fixed(n) => format!("{n} tokens per request"),
        load::Tokens::Pareto { alpha, min, max } => format!("{min} to {max} tokens per request (Pareto {alpha})"),
    };
    println!(
        "load: {arrivals}, {tokens}, Zipf({}) keys over {} | {} repeats of {} s warmup + {} s, {} CPUs",
        load.zipf_s, load.keys, spec.repeats, warmup, duration, cpus
    );
    clock::start();
    let model = Arc::new(model::Model::new(spec.dtype, spec.gateway.hidden, 0x6b69_7465));
    let outcome = bench::run(&spec, model, &cores);

    let mut json = String::new();
    outcome.json.write(&mut json);
    std::fs::write(out.join("bench.json"), json).expect("bench.json");
    let mut lines: Vec<(&String, &u64)> = outcome.folded.iter().collect();
    lines.sort();
    let folded: String = lines.into_iter().map(|(k, v)| format!("{k} {v}\n")).collect();
    std::fs::write(out.join("cpu.folded"), folded).expect("cpu.folded");
    std::fs::write(out.join("percentiles.txt"), outcome.percentiles).expect("percentiles.txt");
}

fn fail(message: &str) -> ! {
    eprintln!("gateway-bench: {message}\n\n{HELP}");
    std::process::exit(2)
}

struct Settings(BTreeMap<String, String>);

impl Settings {
    fn take(&mut self, key: &str, default: &str) -> String {
        self.0.remove(key).unwrap_or_else(|| default.to_string())
    }

    fn num<T: std::str::FromStr>(&mut self, key: &str, default: &str) -> T {
        let v = self.take(key, default);
        v.parse().unwrap_or_else(|_| fail(&format!("{key}={v}: not a number")))
    }

    fn flag(&mut self, key: &str) -> bool {
        match self.take(key, "false").as_str() {
            "true" | "1" | "yes" => true,
            "false" | "0" | "no" | "null" => false,
            v => fail(&format!("{key}={v}: true or false")),
        }
    }

    fn choice(&mut self, key: &str, default: &str, allowed: &[&str]) -> String {
        let v = self.take(key, default);
        if !allowed.contains(&v.as_str()) {
            fail(&format!("{key}={v}: one of {}", allowed.join(", ")));
        }
        v
    }

    fn run_spec(&mut self, seed: u64, repeats: usize, warmup: f64, duration: f64, profile: bool) -> bench::RunSpec {
        let dtype = match self.choice("model_dtype", "int8", &["fp32", "int8"]).as_str() {
            "fp32" => model::Dtype::Fp32,
            _ => model::Dtype::Int8,
        };
        let workers: usize = self.num("workers", "3");
        let gateway = gateway::Config {
            workers: workers.max(1),
            ingress_threads: self.num::<usize>("ingress_threads", "2").max(1),
            dynamic_batching: self.choice("batching", "dynamic", &["none", "dynamic"]) == "dynamic",
            max_batch: self.num::<usize>("max_batch", "16").max(1),
            max_delay_ns: self.num::<u64>("max_delay_us", "250") * 1000,
            policy: batcher::Policy::parse(&self.choice("queue_policy", "edf", &["fifo", "lifo", "edf", "drop-late"])).unwrap(),
            queue_capacity: self.num("queue_capacity", "4096"),
            pin_workers: self.choice("pin", "workers", &["none", "workers"]) == "workers",
            cache: self.choice("cache", "sharded", &["none", "shared", "sharded"]),
            cache_entries: self.num("cache_entries", "16384"),
            cache_shards: self.num("cache_shards", "16"),
            reuse_batch_buffer: self.choice("batch_buffer", "reuse", &["alloc", "reuse"]) == "reuse",
            payload_copy: self.flag("payload_copy"),
            bug_batch_overflow: self.flag("bug_batch_overflow"),
            deadline_ns: (self.num::<f64>("deadline_ms", "12") * 1e6) as u64,
            hidden: self.num("hidden", "1024"),
            top_k: self.num("top_k", "64"),
        };
        let arrivals = match self.choice("arrivals", "poisson", &["poisson", "bursty", "ramp"]).as_str() {
            "bursty" => load::Arrivals::Bursty {
                factor: self.num("burst_factor", "5"),
                burst_ms: self.num("burst_ms", "200"),
                every_ms: self.num("burst_every_ms", "2000"),
            },
            "ramp" => load::Arrivals::Ramp {
                from: self.num("ramp_from", "0.2"),
                to: self.num("ramp_to", "1.2"),
                steps: self.num("ramp_steps", "10"),
                step_ms: self.num("ramp_step_ms", "500"),
            },
            _ => load::Arrivals::Poisson,
        };
        let tokens = match self.choice("tokens", "fixed", &["fixed", "pareto"]).as_str() {
            "pareto" => load::Tokens::Pareto {
                alpha: self.num("tokens_alpha", "1.3"),
                min: self.num("tokens_min", "1"),
                max: self.num("tokens_max", "256"),
            },
            _ => load::Tokens::Fixed(self.num("tokens_n", "8")),
        };
        let load = load::LoadSpec {
            arrivals,
            rate: self.num("rate", "6000"),
            tokens,
            zipf_s: self.num("zipf_s", "0.8"),
            keys: self.num("keys", "100000"),
            deadline_ms: gateway.deadline_ns as f64 / 1e6,
        };
        bench::RunSpec { gateway, load, dtype, seed, repeats: repeats.max(1), warmup_s: warmup, duration_s: duration, profile }
    }

    fn unknown(&self) {
        if let Some(k) = self.0.keys().next() {
            fail(&format!("unknown setting {k}"));
        }
    }
}
