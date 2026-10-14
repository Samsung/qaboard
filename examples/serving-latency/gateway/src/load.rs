//! The load: when each request is sent, its key and its size. Everything is decided from the profile and the seed
//! before the run (open loop): requests go out at their scheduled time whether or not earlier ones completed.

use crate::rng::Rng;

#[derive(Clone, Debug, PartialEq)]
pub enum Arrivals {
    /// Poisson arrivals at the profile's rate
    Poisson,
    /// On/off: `factor` times the base rate for `burst_ms`, about every `every_ms`; the average is the profile's rate
    Bursty { factor: f64, burst_ms: f64, every_ms: f64 },
    /// Poisson, the rate going from `from` to `to` times the profile's rate in `steps` steps of `step_ms`
    Ramp { from: f64, to: f64, steps: u32, step_ms: f64 },
}

#[derive(Clone, Debug, PartialEq)]
pub enum Tokens {
    Fixed(u16),
    /// Pareto (heavy tail): min / U^(1/alpha), at most max
    Pareto { alpha: f64, min: u16, max: u16 },
}

#[derive(Clone, Debug)]
pub struct LoadSpec {
    pub arrivals: Arrivals,
    /// requests/s
    pub rate: f64,
    pub tokens: Tokens,
    /// Zipf exponent and number of distinct keys
    pub zipf_s: f64,
    pub keys: u32,
    pub deadline_ms: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct Scheduled {
    /// Send time, ns after the start of the run
    pub t: u64,
    pub key: u32,
    pub tokens: u16,
}

/// A part of the run with a constant offered rate (the ramp's steps, or the whole measured window)
#[derive(Clone, Copy, Debug)]
pub struct Step {
    pub start: u64,
    pub end: u64,
    pub rate: f64,
}

pub struct Schedule {
    pub requests: Vec<Scheduled>,
    /// The measured window: requests sent in [start, end) count
    pub window: (u64, u64),
    pub steps: Vec<Step>,
    /// When bursts start, for the logs
    pub bursts: Vec<(u64, u64)>,
}

const NS: f64 = 1e9;

/// Rate segments over the whole run, the measured steps, the bursts, the end
type Segments = (Vec<Step>, Vec<Step>, Vec<(u64, u64)>, u64);

/// Zipf(s) over n keys: key k (0-based) has probability proportional to 1/(k+1)^s
pub struct Zipf {
    cdf: Vec<f64>,
}

impl Zipf {
    pub fn new(s: f64, n: u32) -> Self {
        let mut cdf = Vec::with_capacity(n as usize);
        let mut total = 0.0;
        for k in 1..=n {
            total += 1.0 / (k as f64).powf(s);
            cdf.push(total);
        }
        cdf.iter_mut().for_each(|c| *c /= total);
        Zipf { cdf }
    }

    pub fn sample(&self, rng: &mut Rng) -> u32 {
        let u = rng.f64();
        self.cdf.partition_point(|&c| c < u).min(self.cdf.len() - 1) as u32
    }
}

impl Tokens {
    pub fn sample(&self, rng: &mut Rng) -> u16 {
        match *self {
            Tokens::Fixed(n) => n,
            Tokens::Pareto { alpha, min, max } => {
                let x = min as f64 / (1.0 - rng.f64()).powf(1.0 / alpha);
                x.floor().clamp(min as f64, max as f64) as u16
            }
        }
    }
}

impl LoadSpec {
    /// Rate segments over [0, total): (start, end, rate). The warmup runs at the first step's rate.
    fn segments(&self, warmup_ns: u64, duration_ns: u64, rng: &mut Rng) -> Segments {
        match self.arrivals {
            Arrivals::Poisson => {
                let end = warmup_ns + duration_ns;
                let all = vec![Step { start: 0, end, rate: self.rate }];
                (all, vec![Step { start: warmup_ns, end, rate: self.rate }], vec![], end)
            }
            Arrivals::Bursty { factor, burst_ms, every_ms } => {
                let base = self.rate / (1.0 + (factor - 1.0) * burst_ms / every_ms);
                let end = warmup_ns + duration_ns;
                let every = (every_ms * 1e6) as u64;
                let burst = (burst_ms * 1e6) as u64;
                // A burst a quarter of the way into each period, give or take 15% of it: the measured window always
                // has the same number of bursts, at slightly different times for each seed
                let mut bursts = vec![];
                let mut k = 0u64;
                loop {
                    let jitter = (rng.f64() - 0.5) * 0.3 * every as f64;
                    let start = (warmup_ns as f64 + every as f64 * (k as f64 + 0.25) + jitter) as u64;
                    if start + burst > end {
                        break;
                    }
                    bursts.push((start, start + burst));
                    k += 1;
                }
                let mut segments = vec![];
                let mut t = 0;
                for &(s, e) in &bursts {
                    segments.push(Step { start: t, end: s, rate: base });
                    segments.push(Step { start: s, end: e, rate: base * factor });
                    t = e;
                }
                segments.push(Step { start: t, end, rate: base });
                (segments, vec![Step { start: warmup_ns, end, rate: self.rate }], bursts, end)
            }
            Arrivals::Ramp { from, to, steps, step_ms } => {
                let step = (step_ms * 1e6) as u64;
                let mut all = vec![Step { start: 0, end: warmup_ns, rate: self.rate * from }];
                let mut measured = vec![];
                for i in 0..steps {
                    let f = if steps > 1 { from + (to - from) * i as f64 / (steps - 1) as f64 } else { to };
                    let s = Step { start: warmup_ns + i as u64 * step, end: warmup_ns + (i as u64 + 1) * step, rate: self.rate * f };
                    all.push(s);
                    measured.push(s);
                }
                let end = warmup_ns + steps as u64 * step;
                (all, measured, vec![], end)
            }
        }
    }

    pub fn schedule(&self, seed: u64, warmup_s: f64, duration_s: f64) -> Schedule {
        let mut rng = Rng::new(seed);
        let warmup_ns = (warmup_s * NS) as u64;
        let (segments, steps, bursts, end) = self.segments(warmup_ns, (duration_s * NS) as u64, &mut rng);
        let zipf = Zipf::new(self.zipf_s, self.keys);
        let mut requests = Vec::with_capacity((self.rate * (end as f64 / NS) * 1.2) as usize);
        for seg in &segments {
            // Poisson within each segment (memoryless: we can restart at each boundary)
            let mut t = seg.start as f64;
            loop {
                t += rng.exp(NS / seg.rate);
                if t >= seg.end as f64 {
                    break;
                }
                requests.push(Scheduled { t: t as u64, key: zipf.sample(&mut rng), tokens: self.tokens.sample(&mut rng) });
            }
        }
        Schedule { requests, window: (warmup_ns, end), steps, bursts }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(arrivals: Arrivals, tokens: Tokens) -> LoadSpec {
        LoadSpec { arrivals, rate: 4000.0, tokens, zipf_s: 0.8, keys: 100_000, deadline_ms: 12.0 }
    }

    #[test]
    fn deterministic_and_at_the_right_rate() {
        let s = spec(Arrivals::Poisson, Tokens::Fixed(8));
        let a = s.schedule(1, 1.0, 3.0);
        let b = s.schedule(1, 1.0, 3.0);
        assert_eq!(a.requests.len(), b.requests.len());
        assert!(a.requests.iter().zip(&b.requests).all(|(x, y)| x.t == y.t && x.key == y.key));
        let rate = a.requests.len() as f64 / 4.0;
        assert!((rate - 4000.0).abs() < 150.0, "{rate}");
        assert!(a.requests.windows(2).all(|w| w[0].t <= w[1].t));
        assert_ne!(s.schedule(2, 1.0, 3.0).requests[0].t, a.requests[0].t);
    }

    #[test]
    fn bursts_keep_the_average_rate() {
        let s = spec(Arrivals::Bursty { factor: 5.0, burst_ms: 200.0, every_ms: 2000.0 }, Tokens::Fixed(8));
        let sch = s.schedule(3, 1.0, 4.0);
        assert_eq!(sch.bursts.len(), 2);
        let (b0, b1) = sch.bursts[0];
        let in_burst = sch.requests.iter().filter(|r| r.t >= b0 && r.t < b1).count() as f64 / 0.2;
        let base = s.rate / 1.4;
        assert!((in_burst / base - 5.0).abs() < 0.6, "{in_burst} vs {base}");
    }

    #[test]
    fn ramp_steps() {
        let s = spec(Arrivals::Ramp { from: 0.2, to: 1.2, steps: 10, step_ms: 500.0 }, Tokens::Fixed(8));
        let sch = s.schedule(4, 1.0, 0.0);
        assert_eq!(sch.steps.len(), 10);
        assert!((sch.steps[0].rate - 800.0).abs() < 1e-6 && (sch.steps[9].rate - 4800.0).abs() < 1e-6);
        assert_eq!(sch.window, (1_000_000_000, 6_000_000_000));
    }

    #[test]
    fn heavy_tail_tokens() {
        let mut rng = Rng::new(5);
        let t = Tokens::Pareto { alpha: 1.3, min: 1, max: 256 };
        let samples: Vec<u16> = (0..100_000).map(|_| t.sample(&mut rng)).collect();
        assert!(samples.iter().all(|&n| (1..=256).contains(&n)));
        let big = samples.iter().filter(|&&n| n >= 35).count() as f64 / 1e5;
        assert!((0.007..0.014).contains(&big), "{big}");
    }

    #[test]
    fn zipf_favors_small_keys() {
        let z = Zipf::new(0.8, 100_000);
        let mut rng = Rng::new(6);
        let keys: Vec<u32> = (0..50_000).map(|_| z.sample(&mut rng)).collect();
        assert!(keys.iter().all(|&k| k < 100_000));
        let top = keys.iter().filter(|&&k| k < 100).count();
        assert!(top > 5_000 && top < 15_000, "{top}");
    }
}
