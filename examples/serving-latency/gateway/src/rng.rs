//! A small seeded random generator (SplitMix64): the load's schedule, keys and payloads, and the model's weights.
//! Same seed, same numbers, on every machine.

#[derive(Clone)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(mix(seed, 0x5eed))
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    /// Uniform in [0, 1)
    pub fn f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// Uniform in [-1, 1)
    pub fn signed(&mut self) -> f32 {
        (self.f64() * 2.0 - 1.0) as f32
    }

    /// Exponentially distributed, with this mean
    pub fn exp(&mut self, mean: f64) -> f64 {
        -mean * (1.0 - self.f64()).ln()
    }
}

/// Combines two values into a well-mixed hash
pub fn mix(a: u64, b: u64) -> u64 {
    let mut z = a ^ b.wrapping_mul(0x9e37_79b9_7f4a_7c15);
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_seed_same_numbers() {
        let (mut a, mut b) = (Rng::new(42), Rng::new(42));
        for _ in 0..1000 {
            assert_eq!(a.next_u64(), b.next_u64());
        }
        assert_ne!(Rng::new(1).next_u64(), Rng::new(2).next_u64());
    }

    #[test]
    fn uniform_and_exponential_means() {
        let mut rng = Rng::new(7);
        let n = 200_000;
        let mean: f64 = (0..n).map(|_| rng.f64()).sum::<f64>() / n as f64;
        assert!((mean - 0.5).abs() < 0.01, "{mean}");
        let mean: f64 = (0..n).map(|_| rng.exp(3.0)).sum::<f64>() / n as f64;
        assert!((mean - 3.0).abs() < 0.05, "{mean}");
    }
}
