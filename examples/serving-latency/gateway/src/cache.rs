//! The result cache: repeated requests (same key, so the same payload) are answered from the stored outputs without
//! running the model. Every response goes through `respond`: a hit at the ingress, or the model's fresh outputs in a
//! worker.
//!
//! - `shared`: one LRU behind one mutex. The body is rendered while the guard is alive, so the rendering of every
//!   response in the gateway waits for this one lock.
//! - `sharded`: independent LRUs picked by the key's hash; the outputs are copied out and rendered without a lock.

use std::num::NonZeroUsize;
use std::sync::Mutex;

use lru::LruCache;

use crate::clock::now;
use crate::response::{render, Outputs};

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

    /// `computed`: the model's outputs for this request (stored for the next time), or None to look it up.
    /// The body is None when there was nothing to answer from (a miss).
    pub fn respond(&self, id: u32, key: u32, computed: Option<Outputs>) -> Answer {
        match self {
            Cache::None { top_k } => Answer { body: computed.map(|o| render(id, &o, *top_k)), waited: 0 },
            Cache::Shared(c) => c.respond(id, key, computed),
            Cache::Sharded(c) => c.respond(id, key, computed),
        }
    }
}

pub struct Shared {
    lru: Mutex<LruCache<u32, Outputs>>,
    top_k: usize,
}

impl Shared {
    fn new(entries: usize, top_k: usize) -> Self {
        Shared { lru: Mutex::new(LruCache::new(NonZeroUsize::new(entries.max(1)).unwrap())), top_k }
    }

    #[inline(never)]
    pub fn respond(&self, id: u32, key: u32, computed: Option<Outputs>) -> Answer {
        let t = now();
        let mut lru = self.lru.lock().unwrap();
        let waited = now() - t;
        let outputs = match computed {
            Some(outputs) => {
                lru.put(key, outputs);
                lru.peek(&key).unwrap()
            }
            // the LRU update
            None => match lru.get(&key) {
                Some(outputs) => outputs,
                None => return Answer { body: None, waited },
            },
        };
        Answer { body: Some(render(id, outputs, self.top_k)), waited }
    }
}

pub struct Sharded {
    shards: Vec<Mutex<LruCache<u32, Outputs>>>,
    top_k: usize,
}

impl Sharded {
    fn new(entries: usize, shards: usize, top_k: usize) -> Self {
        let shards = shards.max(1);
        let per_shard = NonZeroUsize::new(entries.div_ceil(shards).max(1)).unwrap();
        Sharded { shards: (0..shards).map(|_| Mutex::new(LruCache::new(per_shard))).collect(), top_k }
    }

    fn shard(&self, key: u32) -> &Mutex<LruCache<u32, Outputs>> {
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
            assert!(cache.respond(1, 1, None).body.is_none());
            let outputs: Outputs = vec![256; 2 * D_OUT];
            let fresh = cache.respond(1, 1, Some(outputs.clone())).body.unwrap();
            assert_eq!(cache.respond(1, 1, None).body.unwrap(), fresh, "{kind}: same answer from the cache");
            for k in 100..300 {
                cache.respond(k, k, Some(vec![k as i16; D_OUT]));
            }
            assert!(cache.respond(1, 1, None).body.is_none(), "{kind}: evicted");
        }
        let none = Cache::new("none", 64, 4, 8);
        assert!(!none.enabled());
        assert!(none.respond(1, 1, Some(vec![0; D_OUT])).body.is_some());
    }
}
