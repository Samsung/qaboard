//! The result cache: repeated requests (same key, so the same payload) are answered from the stored outputs without
//! running the model. Every response goes through it: a hit at the ingress (`lookup`), and in a worker, the model's
//! fresh outputs for its batch of misses (`hold`, then `respond` for each request).
//!
//! - `shared`: one LRU behind one mutex. A worker locks it to look its batch up again (another worker may have answered
//!   some of these keys since the ingress missed them: a key is never computed twice), and keeps the guard until the
//!   batch is answered: the model runs, and every response is rendered, while it holds the lock. The ingress renders
//!   its hits under the lock too. So the gateway's work runs one batch at a time, whatever the number of workers.
//! - `sharded`: independent LRUs picked by the key's hash, nothing held across a batch: the model runs without a lock,
//!   outputs are copied in and out of a shard under its lock, and rendered without one.

use std::num::NonZeroUsize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

use lru::LruCache;

use crate::clock::now;
use crate::response::{render, Outputs};

type Lru = LruCache<u32, Outputs>;

pub enum Cache {
    None { top_k: usize },
    Shared(Shared),
    Sharded(Sharded),
}

/// A response body, and how long we waited for a lock (ns)
pub struct Answer {
    pub body: Option<String>,
    pub waited: u64,
}

/// What a worker holds while it answers a batch
pub enum Held<'a> {
    Nothing,
    /// The shared cache's lock, until the guard is dropped
    Shared(Guard<'a>),
}

impl Held<'_> {
    /// Whether the key's outputs are cached (the LRU update): only the shared cache looks keys up again in workers
    pub fn cached(&mut self, key: u32) -> bool {
        match self {
            Held::Shared(guard) => guard.lru.get(&key).is_some(),
            Held::Nothing => false,
        }
    }
}

impl Cache {
    /// `top_k`: what the responses keep of each token's outputs (see response::render)
    pub fn new(kind: &str, entries: usize, shards: usize, top_k: usize) -> Cache {
        match kind {
            "shared" => Cache::Shared(Shared::new(entries, top_k)),
            "sharded" => Cache::Sharded(Sharded::new(entries, shards, top_k)),
            _ => Cache::None { top_k },
        }
    }

    pub fn enabled(&self) -> bool {
        !matches!(self, Cache::None { .. })
    }

    /// At the ingress: the response if the key is cached (a hit), else None
    pub fn lookup(&self, id: u32, key: u32) -> Answer {
        match self {
            Cache::None { .. } => Answer { body: None, waited: 0 },
            Cache::Shared(c) => c.lookup(id, key),
            Cache::Sharded(c) => c.respond(id, key, None),
        }
    }

    /// In a worker, before it runs the model on a batch: what it holds until the batch is answered, and how long it
    /// waited for it (ns)
    pub fn hold(&self) -> (Held<'_>, u64) {
        match self {
            Cache::Shared(c) => {
                let (guard, waited) = c.lock();
                (Held::Shared(guard), waited)
            }
            _ => (Held::Nothing, 0),
        }
    }

    /// In a worker: `computed` is the model's outputs for this request (stored for the next time), or None when it was
    /// cached (`Held::cached`)
    pub fn respond(&self, held: &mut Held, id: u32, key: u32, computed: Option<Outputs>) -> Answer {
        match (self, held) {
            (Cache::None { top_k }, _) => Answer { body: computed.map(|o| render(id, &o, *top_k)), waited: 0 },
            (Cache::Shared(c), Held::Shared(guard)) => c.respond(guard, id, key, computed, 0),
            (Cache::Shared(_), Held::Nothing) => unreachable!("the shared cache answers under its lock: hold() first"),
            (Cache::Sharded(c), _) => c.respond(id, key, computed),
        }
    }

    /// Shared cache: how long its lock was held since the start (ns)
    pub fn lock_held_ns(&self) -> Option<u64> {
        match self {
            Cache::Shared(c) => Some(c.held_ns.load(Ordering::Relaxed)),
            _ => None,
        }
    }
}

pub struct Shared {
    lru: Mutex<Lru>,
    top_k: usize,
    /// Time the lock was held, in total (ns): what limits the gateway's throughput
    held_ns: AtomicU64,
}

/// The shared cache's lock: counts how long it was held when dropped
pub struct Guard<'a> {
    lru: MutexGuard<'a, Lru>,
    since: u64,
    held_ns: &'a AtomicU64,
}

impl Drop for Guard<'_> {
    fn drop(&mut self) {
        self.held_ns.fetch_add(now() - self.since, Ordering::Relaxed);
    }
}

impl Shared {
    fn new(entries: usize, top_k: usize) -> Self {
        let lru = Mutex::new(LruCache::new(NonZeroUsize::new(entries.max(1)).unwrap()));
        Shared { lru, top_k, held_ns: AtomicU64::new(0) }
    }

    /// The lock, and how long we waited for it (ns)
    fn lock(&self) -> (Guard<'_>, u64) {
        let t = now();
        let lru = self.lru.lock().unwrap();
        let since = now();
        (Guard { lru, since, held_ns: &self.held_ns }, since - t)
    }

    #[inline(never)]
    fn lookup(&self, id: u32, key: u32) -> Answer {
        let (mut guard, waited) = self.lock();
        self.respond(&mut guard, id, key, None, waited)
    }

    /// Under the lock: stores the fresh outputs, or looks the key up (the LRU update), and renders the response
    #[inline(never)]
    fn respond(&self, guard: &mut Guard, id: u32, key: u32, computed: Option<Outputs>, waited: u64) -> Answer {
        let lru = &mut guard.lru;
        let outputs = match computed {
            Some(outputs) => {
                lru.put(key, outputs);
                lru.peek(&key).unwrap()
            }
            None => match lru.get(&key) {
                Some(outputs) => outputs,
                None => return Answer { body: None, waited },
            },
        };
        Answer { body: Some(render(id, outputs, self.top_k)), waited }
    }
}

pub struct Sharded {
    shards: Vec<Mutex<Lru>>,
    top_k: usize,
}

impl Sharded {
    fn new(entries: usize, shards: usize, top_k: usize) -> Self {
        let shards = shards.max(1);
        let per_shard = NonZeroUsize::new(entries.div_ceil(shards).max(1)).unwrap();
        Sharded { shards: (0..shards).map(|_| Mutex::new(LruCache::new(per_shard))).collect(), top_k }
    }

    fn shard(&self, key: u32) -> &Mutex<Lru> {
        let h = crate::rng::mix(key as u64, 0x5a4d);
        &self.shards[(h % self.shards.len() as u64) as usize]
    }

    #[inline(never)]
    pub fn respond(&self, id: u32, key: u32, computed: Option<Outputs>) -> Answer {
        let shard = self.shard(key);
        let (outputs, waited) = match computed {
            Some(outputs) => {
                let copy = outputs.clone();
                let t = now();
                let mut lru = shard.lock().unwrap();
                let waited = now() - t;
                let evicted = lru.put(key, copy);
                drop(lru);
                drop(evicted);
                (outputs, waited)
            }
            None => {
                let t = now();
                let mut lru = shard.lock().unwrap();
                let waited = now() - t;
                match lru.get(&key) {
                    Some(outputs) => (outputs.clone(), waited),
                    None => return Answer { body: None, waited },
                }
            }
        };
        Answer { body: Some(render(id, &outputs, self.top_k)), waited }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::D_OUT;

    #[test]
    fn hits_and_evictions() {
        for kind in ["shared", "sharded"] {
            let cache = Cache::new(kind, 64, 4, 8);
            assert!(cache.lookup(1, 1).body.is_none());
            let outputs: Outputs = vec![256; 2 * D_OUT];
            let fresh = {
                let (mut held, _) = cache.hold();
                assert!(!held.cached(1));
                cache.respond(&mut held, 1, 1, Some(outputs.clone())).body.unwrap()
            };
            assert_eq!(cache.lookup(1, 1).body.unwrap(), fresh, "{kind}: same answer from the cache");
            {
                let (mut held, _) = cache.hold();
                assert_eq!(held.cached(1), kind == "shared", "{kind}: only the shared cache looks keys up again in workers");
                if held.cached(1) {
                    assert_eq!(cache.respond(&mut held, 1, 1, None).body.unwrap(), fresh);
                }
                for k in 100..300 {
                    cache.respond(&mut held, k, k, Some(vec![k as i16; D_OUT]));
                }
            }
            assert!(cache.lookup(1, 1).body.is_none(), "{kind}: evicted");
        }
        assert!(Cache::new("shared", 64, 4, 8).lock_held_ns().unwrap() == 0);
        let none = Cache::new("none", 64, 4, 8);
        assert!(!none.enabled());
        let (mut held, _) = none.hold();
        assert!(none.respond(&mut held, 1, 1, Some(vec![0; D_OUT])).body.is_some());
    }
}
