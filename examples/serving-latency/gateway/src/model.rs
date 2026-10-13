//! The "model" the gateway serves: a 2-layer MLP, 256 -> hidden -> 256 with ReLU, applied to each token of a request.
//! fp32, or int8 weights and activations with i32 accumulation. Weights come from a fixed seed. The hidden layer has
//! 1024 units on the reference machine; `calibrate` sizes it for others (see qa/build.py).

use crate::rng::Rng;

pub const D_IN: usize = 256;
pub const D_HID: usize = 1024;
pub const D_OUT: usize = 256;
/// The hidden layer's size is a multiple of this
pub const HIDDEN_STEP: usize = 64;
/// int8: output rows per block of weights (16 KB of W1), which stays in L1 while all the tokens go through it
const BLOCK: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Dtype {
    Fp32,
    Int8,
}

pub struct Model {
    pub dtype: Dtype,
    pub hidden: usize,
    // fp32: [in][out]
    w1t: Vec<f32>,
    b1: Vec<f32>,
    w2t: Vec<f32>,
    b2: Vec<f32>,
    // int8: the same weights quantized per output row (symmetric), with their scales
    w1q: Vec<i8>,
    s1: Vec<f32>,
    w2q: Vec<i8>,
    s2: Vec<f32>,
}

/// Buffers for one batch, kept by a worker between batches (`batch_buffer: reuse`) or allocated for each one
#[derive(Default)]
pub struct Scratch {
    xq: Vec<i16>,
    xs: Vec<f32>,
    h: Vec<f32>,
    hq: Vec<i16>,
    hs: Vec<f32>,
}

impl Scratch {
    pub fn with_capacity(tokens: usize, hidden: usize) -> Self {
        Scratch {
            xq: Vec::with_capacity(tokens * D_IN),
            xs: Vec::with_capacity(tokens),
            h: Vec::with_capacity(tokens * hidden),
            hq: Vec::with_capacity(tokens * hidden),
            hs: Vec::with_capacity(tokens),
        }
    }
}

fn quantize_rows(w: &[f32], rows: usize, cols: usize) -> (Vec<i8>, Vec<f32>) {
    let mut q = vec![0i8; rows * cols];
    let mut scales = vec![0f32; rows];
    for r in 0..rows {
        let row = &w[r * cols..(r + 1) * cols];
        let max = row.iter().fold(0f32, |m, v| m.max(v.abs())).max(1e-12);
        let s = max / 127.0;
        scales[r] = s;
        for (dst, v) in q[r * cols..(r + 1) * cols].iter_mut().zip(row) {
            *dst = (v / s).round().clamp(-127.0, 127.0) as i8;
        }
    }
    (q, scales)
}

fn transpose(w: &[f32], rows: usize, cols: usize) -> Vec<f32> {
    let mut t = vec![0f32; rows * cols];
    for r in 0..rows {
        for c in 0..cols {
            t[c * rows + r] = w[r * cols + c];
        }
    }
    t
}

impl Model {
    pub fn new(dtype: Dtype, hidden: usize, seed: u64) -> Self {
        assert!(hidden > 0 && hidden.is_multiple_of(HIDDEN_STEP), "the hidden layer's size must be a multiple of {HIDDEN_STEP}");
        let mut rng = Rng::new(seed);
        // Scaled so activations keep about the same magnitude through the layers
        let a1 = (3.0 / D_IN as f32).sqrt();
        let a2 = (3.0 / hidden as f32).sqrt() * 2.0;
        let w1: Vec<f32> = (0..hidden * D_IN).map(|_| rng.signed() * a1).collect();
        let b1: Vec<f32> = (0..hidden).map(|_| rng.signed() * 0.05).collect();
        let w2: Vec<f32> = (0..D_OUT * hidden).map(|_| rng.signed() * a2).collect();
        let b2: Vec<f32> = (0..D_OUT).map(|_| rng.signed() * 0.05).collect();
        let (w1q, s1) = quantize_rows(&w1, hidden, D_IN);
        let (w2q, s2) = quantize_rows(&w2, D_OUT, hidden);
        let (w1t, w2t) = (transpose(&w1, hidden, D_IN), transpose(&w2, D_OUT, hidden));
        Model { dtype, hidden, w1t, b1, w2t, b2, w1q, s1, w2q, s2 }
    }

    /// Runs the model on a batch's tokens (each a row of D_IN values), writes D_OUT values per token in `out`
    pub fn forward(&self, tokens: &[&[f32]], scratch: &mut Scratch, out: &mut Vec<f32>) {
        out.clear();
        out.resize(tokens.len() * D_OUT, 0.0);
        match self.dtype {
            Dtype::Fp32 => self.forward_fp32(tokens, scratch, out),
            Dtype::Int8 => self.forward_int8(tokens, scratch, out),
        }
    }

    #[inline(never)]
    fn forward_fp32(&self, x: &[&[f32]], scratch: &mut Scratch, out: &mut [f32]) {
        let n = x.len();
        let d_hid = self.hidden;
        let h = &mut scratch.h;
        h.clear();
        h.resize(n * d_hid, 0.0);
        dense_fp32(x, &self.w1t, &self.b1, D_IN, d_hid, h, true);
        let hidden: Vec<&[f32]> = h.chunks_exact(d_hid).collect();
        dense_fp32(&hidden, &self.w2t, &self.b2, d_hid, D_OUT, out, false);
    }

    #[inline(never)]
    fn forward_int8(&self, x: &[&[f32]], scratch: &mut Scratch, out: &mut [f32]) {
        let n = x.len();
        let d_hid = self.hidden;
        let Scratch { xq, xs, h, hq, hs } = scratch;
        quantize_tokens(x, D_IN, xq, xs);
        h.clear();
        h.resize(n * d_hid, 0.0);
        dense_int8(xq, xs, &self.w1q, &self.s1, &self.b1, D_IN, d_hid, h, true);
        let hidden: Vec<&[f32]> = h.chunks_exact(d_hid).collect();
        quantize_tokens(&hidden, d_hid, hq, hs);
        dense_int8(hq, hs, &self.w2q, &self.s2, &self.b2, d_hid, D_OUT, out, false);
    }
}

/// y[t] = x[t] W + b for each token, fp32. `wt` is [d_in][d_out]: for each input, its weights to every output, so
/// the kernel runs along outputs (no horizontal sums). 4 tokens share each load of weights.
#[inline(never)]
fn dense_fp32(x: &[&[f32]], wt: &[f32], b: &[f32], d_in: usize, d_out: usize, y: &mut [f32], relu: bool) {
    for (tile, x) in x.chunks(4).enumerate() {
        let y = &mut y[tile * 4 * d_out..(tile * 4 + x.len()) * d_out];
        #[cfg(all(target_arch = "x86_64", target_feature = "avx2", target_feature = "fma"))]
        if x.len() == 4 && d_out.is_multiple_of(16) {
            unsafe { simd::dense_fp32_tile4(x, wt, b, d_in, d_out, y, relu) };
            continue;
        }
        for (t, xt) in x.iter().enumerate() {
            let yt = &mut y[t * d_out..(t + 1) * d_out];
            yt.copy_from_slice(&b[..d_out]);
            for (i, &xi) in xt[..d_in].iter().enumerate() {
                for (yj, wj) in yt.iter_mut().zip(&wt[i * d_out..(i + 1) * d_out]) {
                    *yj = xi.mul_add(*wj, *yj);
                }
            }
            if relu {
                yt.iter_mut().for_each(|v| *v = v.max(0.0));
            }
        }
    }
}

/// Per-token symmetric quantization of activations: int8 values, stored widened to i16 for the kernel
#[inline(never)]
fn quantize_tokens(x: &[&[f32]], d: usize, q: &mut Vec<i16>, scales: &mut Vec<f32>) {
    q.clear();
    scales.clear();
    for row in x {
        let row = &row[..d];
        let max = row.iter().fold(0f32, |m, v| m.max(v.abs())).max(1e-12);
        let s = max / 127.0;
        let inv = 1.0 / s;
        scales.push(s);
        q.extend(row.iter().map(|v| (v * inv).round() as i16));
    }
}

/// y[t] = dequantize(xq[t] Wq^T) + b, int8 weights and activations, i32 accumulation. `w` is [d_out][d_in].
#[allow(clippy::too_many_arguments)]
#[inline(never)]
fn dense_int8(xq: &[i16], xs: &[f32], w: &[i8], ws: &[f32], b: &[f32], d_in: usize, d_out: usize, y: &mut [f32], relu: bool) {
    let n = xs.len();
    let mut acc = [0i32; 4];
    for block in (0..d_out).step_by(BLOCK) {
        let end = (block + BLOCK).min(d_out);
        for t0 in (0..n).step_by(4) {
            let tokens = (n - t0).min(4);
            for j in block..end {
                let row = &w[j * d_in..(j + 1) * d_in];
                dot4_i8(&xq[t0 * d_in..(t0 + tokens) * d_in], row, d_in, &mut acc[..tokens]);
                for (k, &a) in acc[..tokens].iter().enumerate() {
                    let v = a as f32 * xs[t0 + k] * ws[j] + b[j];
                    y[(t0 + k) * d_out + j] = if relu { v.max(0.0) } else { v };
                }
            }
        }
    }
}

/// Dot products of up to 4 tokens (consecutive rows of `x`) with one row of weights
#[inline(always)]
fn dot4_i8(x: &[i16], row: &[i8], d_in: usize, acc: &mut [i32]) {
    #[cfg(all(target_arch = "x86_64", target_feature = "avx2"))]
    if acc.len() == 4 && d_in.is_multiple_of(16) {
        unsafe { simd::dot4_i8(x, row, d_in, acc) };
        return;
    }
    for (k, a) in acc.iter_mut().enumerate() {
        *a = x[k * d_in..(k + 1) * d_in].iter().zip(row).map(|(&p, &q)| p as i32 * q as i32).sum();
    }
}

#[cfg(all(target_arch = "x86_64", target_feature = "avx2"))]
mod simd {
    use std::arch::x86_64::*;

    /// 4 tokens x 16 outputs at a time, accumulators in 8 registers
    #[cfg(target_feature = "fma")]
    #[inline(never)]
    pub unsafe fn dense_fp32_tile4(x: &[&[f32]], wt: &[f32], b: &[f32], d_in: usize, d_out: usize, y: &mut [f32], relu: bool) {
        let (x0, x1, x2, x3) = (x[0].as_ptr(), x[1].as_ptr(), x[2].as_ptr(), x[3].as_ptr());
        let zero = _mm256_setzero_ps();
        for j in (0..d_out).step_by(16) {
            let b0 = _mm256_loadu_ps(b.as_ptr().add(j));
            let b1 = _mm256_loadu_ps(b.as_ptr().add(j + 8));
            let (mut a00, mut a01, mut a10, mut a11) = (b0, b1, b0, b1);
            let (mut a20, mut a21, mut a30, mut a31) = (b0, b1, b0, b1);
            let mut wp = wt.as_ptr().add(j);
            for i in 0..d_in {
                let w0 = _mm256_loadu_ps(wp);
                let w1 = _mm256_loadu_ps(wp.add(8));
                let v = _mm256_broadcast_ss(&*x0.add(i));
                a00 = _mm256_fmadd_ps(v, w0, a00);
                a01 = _mm256_fmadd_ps(v, w1, a01);
                let v = _mm256_broadcast_ss(&*x1.add(i));
                a10 = _mm256_fmadd_ps(v, w0, a10);
                a11 = _mm256_fmadd_ps(v, w1, a11);
                let v = _mm256_broadcast_ss(&*x2.add(i));
                a20 = _mm256_fmadd_ps(v, w0, a20);
                a21 = _mm256_fmadd_ps(v, w1, a21);
                let v = _mm256_broadcast_ss(&*x3.add(i));
                a30 = _mm256_fmadd_ps(v, w0, a30);
                a31 = _mm256_fmadd_ps(v, w1, a31);
                wp = wp.add(d_out);
            }
            let yp = y.as_mut_ptr();
            for (t, (lo, hi)) in [(a00, a01), (a10, a11), (a20, a21), (a30, a31)].into_iter().enumerate() {
                let (lo, hi) = if relu { (_mm256_max_ps(lo, zero), _mm256_max_ps(hi, zero)) } else { (lo, hi) };
                _mm256_storeu_ps(yp.add(t * d_out + j), lo);
                _mm256_storeu_ps(yp.add(t * d_out + j + 8), hi);
            }
        }
    }

    #[inline(always)]
    unsafe fn hsum(v: __m256i) -> i32 {
        let s = _mm_add_epi32(_mm256_castsi256_si128(v), _mm256_extracti128_si256(v, 1));
        let s = _mm_add_epi32(s, _mm_shuffle_epi32(s, 0b01_00_11_10));
        let s = _mm_add_epi32(s, _mm_shuffle_epi32(s, 0b10_11_00_01));
        _mm_cvtsi128_si32(s)
    }

    /// int8 x int8 -> i32: the weights widened to i16 once, shared by the 4 tokens (vpmaddwd)
    #[inline(always)]
    pub unsafe fn dot4_i8(x: &[i16], row: &[i8], d_in: usize, acc: &mut [i32]) {
        let xp = x.as_ptr();
        let wp = row.as_ptr();
        let (mut s0, mut s1, mut s2, mut s3) = (_mm256_setzero_si256(), _mm256_setzero_si256(), _mm256_setzero_si256(), _mm256_setzero_si256());
        for k in (0..d_in).step_by(16) {
            let w = _mm256_cvtepi8_epi16(_mm_loadu_si128(wp.add(k) as *const __m128i));
            s0 = _mm256_add_epi32(s0, _mm256_madd_epi16(w, _mm256_loadu_si256(xp.add(k) as *const __m256i)));
            s1 = _mm256_add_epi32(s1, _mm256_madd_epi16(w, _mm256_loadu_si256(xp.add(d_in + k) as *const __m256i)));
            s2 = _mm256_add_epi32(s2, _mm256_madd_epi16(w, _mm256_loadu_si256(xp.add(2 * d_in + k) as *const __m256i)));
            s3 = _mm256_add_epi32(s3, _mm256_madd_epi16(w, _mm256_loadu_si256(xp.add(3 * d_in + k) as *const __m256i)));
        }
        acc[0] = hsum(s0);
        acc[1] = hsum(s1);
        acc[2] = hsum(s2);
        acc[3] = hsum(s3);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn int8_close_to_fp32() {
        let mut rng = Rng::new(9);
        let tokens: Vec<Vec<f32>> = (0..5).map(|_| (0..D_IN).map(|_| rng.signed()).collect()).collect();
        let rows: Vec<&[f32]> = tokens.iter().map(|t| t.as_slice()).collect();
        let (mut out32, mut out8) = (vec![], vec![]);
        Model::new(Dtype::Fp32, D_HID, 1).forward(&rows, &mut Scratch::default(), &mut out32);
        Model::new(Dtype::Int8, D_HID, 1).forward(&rows, &mut Scratch::default(), &mut out8);
        assert_eq!(out32.len(), 5 * D_OUT);
        let norm = out32.iter().map(|v| v * v).sum::<f32>().sqrt();
        let err = out32.iter().zip(&out8).map(|(a, b)| (a - b) * (a - b)).sum::<f32>().sqrt();
        assert!(norm > 1.0, "{norm}");
        assert!(err / norm < 0.05, "relative error {}", err / norm);
    }

    #[test]
    fn batching_does_not_change_results() {
        let mut rng = Rng::new(10);
        let tokens: Vec<Vec<f32>> = (0..12).map(|_| (0..D_IN).map(|_| rng.signed()).collect()).collect();
        let rows: Vec<&[f32]> = tokens.iter().map(|t| t.as_slice()).collect();
        for dtype in [Dtype::Fp32, Dtype::Int8] {
            let model = Model::new(dtype, 512, 2);
            let mut all = vec![];
            model.forward(&rows, &mut Scratch::default(), &mut all);
            let mut one = vec![];
            model.forward(&rows[7..8], &mut Scratch::default(), &mut one);
            assert_eq!(&all[7 * D_OUT..8 * D_OUT], &one[..]);
        }
    }
}

#[cfg(test)]
mod speed {
    use super::*;

    fn cpu_s() -> f64 {
        let mut t: libc::timespec = unsafe { std::mem::zeroed() };
        unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut t) };
        t.tv_sec as f64 + t.tv_nsec as f64 * 1e-9
    }

    /// CPU time of the model and of rendering a response: cargo test --release speed -- --ignored --nocapture
    #[test]
    #[ignore]
    fn speed() {
        let mut rng = Rng::new(1);
        let tokens: Vec<Vec<f32>> = (0..128).map(|_| (0..D_IN).map(|_| rng.signed()).collect()).collect();
        for dtype in [Dtype::Fp32, Dtype::Int8] {
            let model = Model::new(dtype, D_HID, 3);
            for n in [8, 32, 128] {
                let rows: Vec<&[f32]> = tokens[..n].iter().map(|t| t.as_slice()).collect();
                let (mut scratch, mut out) = (Scratch::default(), vec![]);
                let start = cpu_s();
                let mut done = 0;
                while cpu_s() - start < 0.5 {
                    model.forward(&rows, &mut scratch, &mut out);
                    done += n;
                }
                println!("{dtype:?} hidden {D_HID} batch of {n} tokens: {:.1} us/token", (cpu_s() - start) * 1e6 / done as f64);
            }
        }
        let values: Vec<i16> = (0..2048).map(|_| (rng.signed() * 2000.0) as i16).collect();
        let start = cpu_s();
        let mut n = 0;
        while cpu_s() - start < 0.5 {
            std::hint::black_box(crate::response::render(1, &values, crate::response::TOP_K));
            n += 1;
        }
        println!("render 8 tokens: {:.1} us", (cpu_s() - start) * 1e6 / n as f64);
    }
}
