//! The queue and the batcher (one thread). Requests wait in a bounded queue; when a worker is idle, the batcher
//! closes a batch at `max_batch` requests or `max_delay` after it opened, taking requests in the policy's order.

use std::cmp::{Ordering as CmpOrdering, Reverse};
use std::collections::{BinaryHeap, VecDeque};
use std::sync::atomic::Ordering;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::time::Duration;

use crate::clock::now;
use crate::gateway::{Config, Done, Live, Request};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Policy {
    Fifo,
    Lifo,
    /// Earliest deadline first, among requests that can still make it; the ones already late go after them
    Edf,
    /// Earliest deadline first, and requests already past their deadline are dropped
    DropLate,
}

impl Policy {
    pub fn parse(s: &str) -> Option<Policy> {
        Some(match s {
            "fifo" => Policy::Fifo,
            "lifo" => Policy::Lifo,
            "edf" => Policy::Edf,
            "drop-late" => Policy::DropLate,
            _ => return None,
        })
    }
}

pub enum Event {
    Request(Request),
    /// A worker is idle again, since then
    Free(usize, u64),
    Shutdown,
}

pub struct Batch {
    pub requests: Vec<Request>,
    /// When a worker was idle and requests were waiting
    pub t_open: u64,
    pub t_close: u64,
}

struct ByDeadline(Request);

impl PartialEq for ByDeadline {
    fn eq(&self, other: &Self) -> bool {
        (self.0.deadline, self.0.id) == (other.0.deadline, other.0.id)
    }
}
impl Eq for ByDeadline {}
impl PartialOrd for ByDeadline {
    fn partial_cmp(&self, other: &Self) -> Option<CmpOrdering> {
        Some(self.cmp(other))
    }
}
impl Ord for ByDeadline {
    fn cmp(&self, other: &Self) -> CmpOrdering {
        (self.0.deadline, self.0.id).cmp(&(other.0.deadline, other.0.id))
    }
}

pub struct Queue {
    policy: Policy,
    capacity: usize,
    deque: VecDeque<Request>,
    on_time: BinaryHeap<Reverse<ByDeadline>>,
    /// edf: requests found past their deadline, served (oldest first) when no on-time request waits
    late: VecDeque<Request>,
}

impl Queue {
    pub fn new(policy: Policy, capacity: usize) -> Self {
        Queue { policy, capacity, deque: VecDeque::new(), on_time: BinaryHeap::new(), late: VecDeque::new() }
    }

    pub fn len(&self) -> usize {
        self.deque.len() + self.on_time.len() + self.late.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Err(request) when the queue is full
    pub fn push(&mut self, r: Request) -> Result<(), Request> {
        if self.len() >= self.capacity {
            return Err(r);
        }
        match self.policy {
            Policy::Fifo | Policy::Lifo => self.deque.push_back(r),
            Policy::Edf | Policy::DropLate => self.on_time.push(Reverse(ByDeadline(r))),
        }
        Ok(())
    }

    /// When the oldest waiting request arrived
    pub fn oldest(&self) -> Option<u64> {
        let a = self.deque.front().map(|r| r.t_queued);
        let b = self.on_time.peek().map(|r| r.0 .0.t_queued);
        let c = self.late.front().map(|r| r.t_queued);
        [a, b, c].into_iter().flatten().min()
    }

    /// The next request in the policy's order. drop-late returns the late ones it drops in `dropped`.
    pub fn pop(&mut self, now: u64, dropped: &mut Vec<Request>) -> Option<Request> {
        match self.policy {
            Policy::Fifo => self.deque.pop_front(),
            Policy::Lifo => self.deque.pop_back(),
            Policy::Edf => {
                while let Some(Reverse(ByDeadline(r))) = self.on_time.pop() {
                    if r.deadline >= now {
                        return Some(r);
                    }
                    self.late.push_back(r);
                }
                self.late.pop_front()
            }
            Policy::DropLate => {
                while let Some(Reverse(ByDeadline(r))) = self.on_time.pop() {
                    if r.deadline >= now {
                        return Some(r);
                    }
                    dropped.push(r);
                }
                None
            }
        }
    }
}

/// Queued requests from which the batcher considers it has a backlog
const BACKLOG: usize = 1024;

/// Takes up to `max_batch` requests from the queue
#[inline(never)]
fn form_batch(queue: &mut Queue, cfg: &Config, now: u64, dropped: &mut Vec<Request>) -> Vec<Request> {
    let max_batch = if cfg.dynamic_batching { cfg.max_batch } else { 1 };
    if cfg.bug_batch_overflow && cfg.dynamic_batching && queue.len() > BACKLOG {
        return fill_batch(queue, max_batch, now, dropped);
    }
    let mut batch = Vec::with_capacity(max_batch);
    while batch.len() < max_batch {
        match queue.pop(now, dropped) {
            Some(r) => batch.push(r),
            None => break,
        }
    }
    batch
}

/// Under a backlog, fill the batch up to max_batch before flushing it
#[inline(never)]
fn fill_batch(queue: &mut Queue, max_batch: usize, now: u64, dropped: &mut Vec<Request>) -> Vec<Request> {
    let mut slots: Vec<Option<Request>> = (0..max_batch).map(|_| None).collect();
    let mut n = 0;
    while n <= max_batch && !queue.is_empty() {
        slots[n] = queue.pop(now, dropped);
        n += 1;
    }
    slots.into_iter().flatten().collect()
}

fn record_drop(r: Request, done: &mut Vec<Done>, live: &Live) {
    live.dropped.fetch_add(1, Ordering::Relaxed);
    done.push(Done { id: r.id, t_sched: r.t_sched, t_done: now(), dropped: true, ..Default::default() });
}

/// The dropped requests, and (time, size) of each batch
pub type Outcome = (Vec<Done>, Vec<(u64, u16)>);

/// The batcher thread
pub fn run(events: Receiver<Event>, workers: Vec<Sender<Batch>>, cfg: &Config, live: &Live) -> Outcome {
    let mut queue = Queue::new(cfg.policy, cfg.queue_capacity);
    let mut idle: Vec<(usize, u64)> = (0..workers.len()).rev().map(|w| (w, 0)).collect();
    let mut done = vec![];
    let mut batches = vec![];
    let mut dropped = vec![];
    let mut shutdown = false;
    while !shutdown {
        // Wait for something to happen, or for the open batch's delay to run out
        let deadline = if cfg.dynamic_batching && !idle.is_empty() {
            queue.oldest().map(|oldest| batch_open(oldest, &idle) + cfg.max_delay_ns)
        } else {
            None
        };
        let first = match deadline {
            Some(d) => {
                let n = now();
                if d <= n {
                    None
                } else {
                    match events.recv_timeout(Duration::from_nanos(d - n)) {
                        Ok(e) => Some(e),
                        Err(RecvTimeoutError::Timeout) => None,
                        Err(RecvTimeoutError::Disconnected) => break,
                    }
                }
            }
            None => match events.recv() {
                Ok(e) => Some(e),
                Err(_) => break,
            },
        };
        let mut handle = |e: Event, queue: &mut Queue, idle: &mut Vec<(usize, u64)>| match e {
            Event::Request(mut r) => {
                r.t_queued = now();
                if let Err(r) = queue.push(r) {
                    record_drop(r, &mut done, live);
                }
                live.queue_depth_max.fetch_max(queue.len() as u32, Ordering::Relaxed);
                false
            }
            Event::Free(w, t) => {
                idle.push((w, t));
                false
            }
            Event::Shutdown => true,
        };
        if let Some(e) = first {
            shutdown |= handle(e, &mut queue, &mut idle);
        }
        while let Ok(e) = events.try_recv() {
            shutdown |= handle(e, &mut queue, &mut idle);
        }
        // Close batches for idle workers
        while !idle.is_empty() && !queue.is_empty() {
            let n = now();
            let open = batch_open(queue.oldest().unwrap(), &idle);
            let max_batch = if cfg.dynamic_batching { cfg.max_batch } else { 1 };
            if cfg.dynamic_batching && queue.len() < max_batch && n < open + cfg.max_delay_ns {
                break;
            }
            let requests = form_batch(&mut queue, cfg, n, &mut dropped);
            for r in dropped.drain(..) {
                record_drop(r, &mut done, live);
            }
            if requests.is_empty() {
                continue;
            }
            batches.push((n, requests.len() as u16));
            let (w, _) = idle.pop().unwrap();
            let batch = Batch { requests, t_open: open.min(n), t_close: n };
            if workers[w].send(batch).is_err() {
                return (done, batches);
            }
        }
    }
    // What's left when we stop never completes: dropped
    let mut rest = vec![];
    while let Some(r) = queue.pop(u64::MAX, &mut rest) {
        rest.push(r);
    }
    for r in rest {
        record_drop(r, &mut done, live);
    }
    (done, batches)
}

/// A batch opens when a request is waiting and a worker is idle
fn batch_open(oldest_request: u64, idle: &[(usize, u64)]) -> u64 {
    let first_idle = idle.iter().map(|&(_, t)| t).min().unwrap_or(0);
    oldest_request.max(first_idle)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(id: u32, deadline: u64) -> Request {
        Request { id, key: id, tokens: 1, t_sched: 0, deadline, t_ingress: 0, t_queued: id as u64, lock_ns: 0, payload: vec![] }
    }

    #[test]
    fn policies() {
        let mut dropped = vec![];
        let order = |policy, now| {
            let mut q = Queue::new(policy, 10);
            for (id, deadline) in [(1, 30), (2, 10), (3, 20)] {
                q.push(request(id, deadline)).ok().unwrap();
            }
            let mut dropped = vec![];
            let ids: Vec<u32> = std::iter::from_fn(|| q.pop(now, &mut dropped)).map(|r| r.id).collect();
            (ids, dropped.len())
        };
        assert_eq!(order(Policy::Fifo, 0), (vec![1, 2, 3], 0));
        assert_eq!(order(Policy::Lifo, 0), (vec![3, 2, 1], 0));
        assert_eq!(order(Policy::Edf, 0), (vec![2, 3, 1], 0));
        // at 15, request 2 is late: edf serves it last, drop-late drops it
        assert_eq!(order(Policy::Edf, 15), (vec![3, 1, 2], 0));
        assert_eq!(order(Policy::DropLate, 15), (vec![3, 1], 1));
        let mut q = Queue::new(Policy::Fifo, 1);
        assert!(q.push(request(1, 0)).is_ok());
        assert!(q.push(request(2, 0)).is_err());
        assert!(q.pop(0, &mut dropped).is_some());
    }
}
