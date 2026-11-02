//! Sizes the work of a request for the machine: `gateway-bench --calibrate`.
//!
//! The load levels are fixed (2,000, 4,000, 6,000 requests/s), so how loaded the gateway is depends on how fast the
//! machine is. To tell the same story on any machine, the model's hidden layer and what responses keep of each token
//! are sized once per machine, so that a request costs about what it costs on the reference machine: the gateway
//! (no cache) saturates around 7,000 requests/s with 3 workers, and rendering is about a quarter of a request's CPU.
//! qa/build.py runs this once and keeps the result (gateway/target/calibration.json).

use crate::json::Json;
use crate::model::{Dtype, Model, Scratch, D_HID, D_IN, D_OUT, HIDDEN_STEP};
use crate::response::{render, to_outputs, TOP_K};
use crate::rng::Rng;

/// CPU time on the reference machine, for an 8-token request: the int8 model, and rendering the response. Measured
/// alone, on one core: in the running gateway, with every core busy, they take about 25% more (250 and 110 µs).
pub const MODEL_US: f64 = 200.0;
pub const RENDER_US: f64 = 90.0;

fn thread_cpu_s() -> f64 {
    let mut t: libc::timespec = unsafe { std::mem::zeroed() };
    unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut t) };
    t.tv_sec as f64 + t.tv_nsec as f64 * 1e-9
}

/// The median over 7 trials of 0.15 s of CPU time, in µs per call
fn time(mut f: impl FnMut()) -> f64 {
    f();
    let mut trials: Vec<f64> = (0..7)
        .map(|_| {
            let start = thread_cpu_s();
            let mut n = 0;
            while thread_cpu_s() - start < 0.15 {
                f();
                n += 1;
            }
            (thread_cpu_s() - start) * 1e6 / n as f64
        })
        .collect();
    trials.sort_by(|a, b| a.partial_cmp(b).unwrap());
    trials[3]
}

pub fn run() -> Json {
    let mut rng = Rng::new(7);
    let tokens: Vec<Vec<f32>> = (0..8).map(|_| (0..D_IN).map(|_| rng.signed()).collect()).collect();
    let rows: Vec<&[f32]> = tokens.iter().map(|t| t.as_slice()).collect();
    let model = Model::new(Dtype::Int8, D_HID, 3);
    let (mut scratch, mut out) = (Scratch::default(), vec![]);
    let model_us = time(|| model.forward(&rows, &mut scratch, &mut out));
    model.forward(&rows, &mut scratch, &mut out);
    let outputs = to_outputs(&out);
    assert_eq!(outputs.len(), 8 * D_OUT);
    let render_us = time(|| {
        std::hint::black_box(render(1, &outputs, TOP_K));
    });
    // Both costs grow about linearly with these
    let hidden = ((D_HID as f64 * MODEL_US / model_us / HIDDEN_STEP as f64).round() as usize * HIDDEN_STEP).clamp(256, 4096);
    let top_k = ((TOP_K as f64 * RENDER_US / render_us).round() as usize).clamp(8, D_OUT);
    Json::obj([
        ("hidden", Json::from(hidden)),
        ("top_k", Json::from(top_k)),
        ("measured", Json::obj([("model_us", Json::Num(model_us)), ("render_us", Json::Num(render_us)), ("hidden", Json::from(D_HID)), ("top_k", Json::from(TOP_K))])),
        ("reference", Json::obj([("model_us", Json::Num(MODEL_US)), ("render_us", Json::Num(RENDER_US))])),
    ])
}
