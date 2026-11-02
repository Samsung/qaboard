//! What the gateway sends back: for each token, its strongest outputs (a sparse embedding), as JSON.

use std::fmt::Write;

use crate::model::D_OUT;

/// Outputs kept per token in the response, on the reference machine (`calibrate` sizes it for others)
pub const TOP_K: usize = 64;

/// The model's outputs for a request, 16-bit fixed point (D_OUT per token: 4 KB for 8 tokens). What the cache stores.
pub type Outputs = Vec<i16>;

pub fn to_outputs(values: &[f32]) -> Outputs {
    values.iter().map(|v| (v * 256.0).round().clamp(-32768.0, 32767.0) as i16).collect()
}

/// The HTTP response's body: `{"id":..,"tokens":[{"top":[17,203,..],"scores":[2.41,2.17,..]},..]}`, about 7 KB for
/// 8 tokens. Formatting the scores is most of the cost.
#[inline(never)]
pub fn render(id: u32, outputs: &[i16], top_k: usize) -> String {
    let tokens = outputs.len() / D_OUT;
    let mut body = String::with_capacity(64 + tokens * top_k * 14);
    write!(body, "{{\"id\":{id},\"model\":\"k3-embed\",\"tokens\":[").unwrap();
    let mut order: Vec<u16> = (0..D_OUT as u16).collect();
    for (t, token) in outputs.chunks_exact(D_OUT).enumerate() {
        order.sort_unstable_by_key(|&i| std::cmp::Reverse(token[i as usize]));
        let top = &order[..top_k.min(D_OUT)];
        body.push_str(if t == 0 { "{\"top\":[" } else { ",{\"top\":[" });
        for (k, &i) in top.iter().enumerate() {
            if k > 0 {
                body.push(',');
            }
            write!(body, "{i}").unwrap();
        }
        body.push_str("],\"scores\":[");
        for (k, &i) in top.iter().enumerate() {
            if k > 0 {
                body.push(',');
            }
            write!(body, "{}", token[i as usize] as f32 / 256.0).unwrap();
        }
        body.push_str("]}");
    }
    body.push_str("]}");
    body
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_the_top_outputs() {
        let mut outputs = vec![0i16; 2 * D_OUT];
        outputs[5] = 512; // 2.0
        outputs[D_OUT + 9] = -64;
        let body = render(7, &outputs, TOP_K);
        assert!(body.starts_with("{\"id\":7,\"model\":\"k3-embed\",\"tokens\":[{\"top\":[5,"), "{body}");
        assert!(body.contains("\"scores\":[2,0,"), "{body}");
        assert_eq!(body.matches("\"top\"").count(), 2);
        assert!(body.ends_with("]}]}"));
    }
}
