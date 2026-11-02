//! The gateway: ingress threads look up the result cache and pass misses to the batcher; the batcher forms batches
//! for idle workers; workers run the model, store the results in the cache and complete the requests.
//!
//!   load generator -> ingress (2 threads) -> batcher (1 thread, bounded queue) -> workers (N threads)

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};

use crate::batcher::{self, Batch, Event, Policy};
use crate::cache::Cache;
use crate::response::to_outputs;
use crate::clock::now;
use crate::model::{Model, Scratch, D_IN, D_OUT};

#[derive(Clone, Debug)]
pub struct Config {
    pub workers: usize,
    pub ingress_threads: usize,
    pub dynamic_batching: bool,
    pub max_batch: usize,
    pub max_delay_ns: u64,
    pub policy: Policy,
    pub queue_capacity: usize,
    pub pin_workers: bool,
    pub cache: String,
    pub cache_entries: usize,
    pub cache_shards: usize,
    pub reuse_batch_buffer: bool,
    pub payload_copy: bool,
    pub bug_batch_overflow: bool,
    pub deadline_ns: u64,
    /// The model's hidden layer, and what responses keep of each token (sized for the machine, see calibrate.rs)
    pub hidden: usize,
    pub top_k: usize,
}

pub struct Request {
    pub id: u32,
    pub key: u32,
    pub tokens: u16,
    /// When the load generator was scheduled to send it (latency is measured from there)
    pub t_sched: u64,
    pub deadline: u64,
    pub t_ingress: u64,
    /// Arrival in the batcher's queue
    pub t_queued: u64,
    /// Time spent waiting for cache locks
    pub lock_ns: u64,
    /// D_IN values per token
    pub payload: Vec<f32>,
}

/// A finished (or dropped) request, with where its time went
#[derive(Clone, Copy, Debug, Default)]
pub struct Done {
    pub id: u32,
    pub t_sched: u64,
    pub t_done: u64,
    pub queue: u64,
    pub batch: u64,
    pub lock: u64,
    pub compute: u64,
    pub hit: bool,
    pub dropped: bool,
}

impl Done {
    pub fn latency(&self) -> u64 {
        self.t_done.saturating_sub(self.t_sched)
    }
}

/// What the main thread watches while the run goes: counters, and the worst things since its last look
#[derive(Default)]
pub struct Live {
    pub sent: AtomicU64,
    pub completed: AtomicU64,
    pub dropped: AtomicU64,
    pub queue_depth_max: AtomicU32,
    /// (how late in µs << 32) | request id: fetch_max keeps the latest request
    pub worst_miss: AtomicU64,
    pub misses: AtomicU32,
}

impl Live {
    pub fn completed(&self, done: &Done, deadline: u64) {
        self.completed.fetch_add(1, Ordering::Relaxed);
        if done.t_done > deadline {
            self.misses.fetch_add(1, Ordering::Relaxed);
            let late_us = ((done.t_done - deadline) / 1000).min(u32::MAX as u64);
            self.worst_miss.fetch_max((late_us << 32) | done.id as u64, Ordering::Relaxed);
        }
    }
}

pub struct Running {
    pub ingress: Vec<Sender<Request>>,
    events: Sender<Event>,
    handles: Vec<(String, JoinHandle<Vec<Done>>)>,
    batcher: Option<JoinHandle<batcher::Outcome>>,
    /// (thread name, Linux thread id): to read their CPU time
    pub threads: Vec<(String, i32)>,
}

pub struct Finished {
    pub done: Vec<Done>,
    /// (when, size) of each batch
    pub batches: Vec<(u64, u16)>,
}

/// The Linux thread id, to read the thread's CPU time in /proc (elsewhere: 0, no CPU time)
fn thread_id() -> i32 {
    #[cfg(target_os = "linux")]
    return unsafe { libc::gettid() };
    #[cfg(not(target_os = "linux"))]
    return 0;
}

fn spawn<T: Send + 'static>(name: String, tids: &Sender<(String, i32)>, core: Option<usize>, f: impl FnOnce() -> T + Send + 'static) -> JoinHandle<T> {
    let tids = tids.clone();
    let thread_name = name.clone();
    thread::Builder::new()
        .name(name)
        .spawn(move || {
            if let Some(core) = core {
                core_affinity::set_for_current(core_affinity::CoreId { id: core });
            }
            let _ = tids.send((thread_name, thread_id()));
            f()
        })
        .expect("spawn")
}

pub fn start(cfg: &Config, model: Arc<Model>, cache: Arc<Cache>, live: Arc<Live>, cores: &[usize]) -> Running {
    let (tid_tx, tid_rx) = channel();
    let (events_tx, events_rx) = channel::<Event>();
    let mut handles = vec![];
    let mut worker_txs = vec![];
    for w in 0..cfg.workers {
        let (tx, rx) = channel::<Batch>();
        worker_txs.push(tx);
        let (model, cache, live, events, cfg) = (model.clone(), cache.clone(), live.clone(), events_tx.clone(), cfg.clone());
        // pinned on cores 1, 2, 3...: the load generator keeps core 0
        let core = if cfg.pin_workers { cores.get(1 + w).copied() } else { None };
        handles.push((format!("worker-{w}"), spawn(format!("worker-{w}"), &tid_tx, core, move || worker(w, rx, events, &model, &cache, &cfg, &live))));
    }
    let batcher = {
        let (cfg, live) = (cfg.clone(), live.clone());
        spawn("batcher".into(), &tid_tx, None, move || batcher::run(events_rx, worker_txs, &cfg, &live))
    };
    let mut ingress = vec![];
    for i in 0..cfg.ingress_threads {
        let (tx, rx) = channel::<Request>();
        ingress.push(tx);
        let (cache, live, events) = (cache.clone(), live.clone(), events_tx.clone());
        handles.push((format!("ingress-{i}"), spawn(format!("ingress-{i}"), &tid_tx, None, move || ingress_loop(rx, events, &cache, &live))));
    }
    drop(tid_tx);
    let threads = tid_rx.iter().take(cfg.workers + 1 + cfg.ingress_threads).collect();
    Running { ingress, events: events_tx, handles, batcher: Some(batcher), threads }
}

impl Running {
    /// Once every request is done: stops the threads and collects what they recorded
    pub fn stop(mut self) -> Finished {
        self.ingress.clear();
        let _ = self.events.send(Event::Shutdown);
        let (mut done, batches) = self.batcher.take().unwrap().join().expect("batcher");
        for (_, h) in self.handles {
            done.extend(h.join().expect("gateway thread"));
        }
        Finished { done, batches }
    }
}

#[inline(never)]
fn ingress_loop(rx: Receiver<Request>, events: Sender<Event>, cache: &Cache, live: &Live) -> Vec<Done> {
    let mut done = vec![];
    for mut r in rx {
        r.t_ingress = now();
        if cache.enabled() {
            let answer = cache.lookup(r.id, r.key);
            r.lock_ns = answer.waited;
            if let Some(body) = answer.body {
                let t_done = now();
                send_response(body);
                let d = Done {
                    id: r.id, t_sched: r.t_sched, t_done, queue: r.t_ingress.saturating_sub(r.t_sched), batch: 0,
                    lock: answer.waited, compute: (t_done - r.t_ingress).saturating_sub(answer.waited), hit: true, dropped: false,
                };
                live.completed(&d, r.deadline);
                done.push(d);
                continue;
            }
        }
        if events.send(Event::Request(r)).is_err() {
            break;
        }
    }
    done
}

/// Where the body would go out on the network
fn send_response(body: String) {
    std::hint::black_box(body.len());
}

#[inline(never)]
fn worker(id: usize, rx: Receiver<Batch>, events: Sender<Event>, model: &Model, cache: &Cache, cfg: &Config, live: &Live) -> Vec<Done> {
    let mut done = vec![];
    let mut kept_scratch = Scratch::with_capacity(cfg.max_batch * 8, cfg.hidden);
    let mut kept_out: Vec<f32> = Vec::with_capacity(cfg.max_batch * 8 * D_OUT);
    let mut kept_copy: Vec<f32> = Vec::new();
    for batch in rx {
        // The shared cache is locked here, and stays locked until `held` is dropped, once the batch is answered: the
        // model runs and the responses are rendered under its lock (see cache.rs)
        let (mut held, held_wait) = cache.hold();
        // Requests answered since the ingress missed them (shared cache only): no need to run the model on them
        let cached: Vec<bool> = batch.requests.iter().map(|r| held.cached(r.key)).collect();
        let todo: Vec<&Request> = batch.requests.iter().zip(&cached).filter(|(_, &c)| !c).map(|(r, _)| r).collect();
        let t_start = now();
        let (mut fresh_scratch, mut fresh_out, mut fresh_copy);
        let (scratch, out, copy) = if cfg.reuse_batch_buffer {
            (&mut kept_scratch, &mut kept_out, &mut kept_copy)
        } else {
            fresh_scratch = Scratch::default();
            fresh_out = Vec::new();
            fresh_copy = Vec::new();
            (&mut fresh_scratch, &mut fresh_out, &mut fresh_copy)
        };
        // borrowed: the payloads' tokens, back to back; copied: one slot per request, as long as the longest payload
        let slot = if cfg.payload_copy { copy_payloads(&todo, copy) } else { 0 };
        let tokens: Vec<&[f32]> = if cfg.payload_copy {
            copy.chunks_exact(D_IN).collect()
        } else {
            todo.iter().flat_map(|r| r.payload.chunks_exact(D_IN)).collect()
        };
        if !tokens.is_empty() {
            model.forward(&tokens, scratch, out);
        }
        drop(tokens);
        let model_ns = now() - t_start;
        // Each request is answered as soon as its body is rendered (through the cache, which stores the outputs)
        let mut offset = 0;
        for (r, &cached) in batch.requests.iter().zip(&cached) {
            let outputs = if cached {
                None
            } else {
                let n = r.tokens as usize * D_OUT;
                let outputs = to_outputs(&out[offset..offset + n]);
                offset += if cfg.payload_copy { slot * D_OUT } else { n };
                Some(outputs)
            };
            let t_respond = now();
            let answer = cache.respond(&mut held, r.id, r.key, outputs);
            let t_done = now();
            send_response(answer.body.unwrap_or_default());
            let batch_wait = batch.t_close.saturating_sub(r.t_queued.max(batch.t_open));
            let total = t_done - r.t_sched;
            let lock = r.lock_ns + held_wait + answer.waited;
            let compute = model_ns + (t_done - t_respond).saturating_sub(answer.waited);
            let d = Done {
                id: r.id, t_sched: r.t_sched, t_done, batch: batch_wait, lock, compute,
                queue: total.saturating_sub(batch_wait + lock + compute), hit: cached, dropped: false,
            };
            live.completed(&d, r.deadline);
            done.push(d);
        }
        drop(held);
        drop(todo);
        drop(batch);
        if events.send(Event::Free(id, now())).is_err() {
            break;
        }
    }
    done
}

/// `payload_copy`: the batch's payloads copied into one [requests x longest payload x D_IN] buffer, zero-padded.
/// Simpler than a list of borrowed slices, but the model runs on the padding too. Returns the slot's length (tokens).
#[inline(never)]
fn copy_payloads(requests: &[&Request], buffer: &mut Vec<f32>) -> usize {
    let slot = requests.iter().map(|r| r.tokens as usize).max().unwrap_or(0);
    buffer.clear();
    buffer.resize(requests.len() * slot * D_IN, 0.0);
    for (i, r) in requests.iter().enumerate() {
        buffer[i * slot * D_IN..][..r.payload.len()].copy_from_slice(&r.payload);
    }
    slot
}
