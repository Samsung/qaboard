# Inputs, code and their licenses

## Inputs
None downloaded. The load profiles (`inputs/profiles/*.yaml`) are written by `qa/make_profiles.py`, and the payloads
and the model's weights are generated from seeds by `gateway-bench`. They are ours, under the repository's license
(Apache-2.0).

## Rust dependencies of `gateway-bench`
Pinned in `gateway/Cargo.lock`, fetched from crates.io when it builds. Checked on 2026-10-13: all are under permissive
licenses (MIT, Apache-2.0, BSD, Zlib, Unlicense, Unicode-3.0), none copyleft. The direct ones:

| Crate | Used for | License |
|---|---|---|
| [`pprof`](https://github.com/tikv/pprof-rs) 0.15 | CPU samples of all threads, for the flame graph | Apache-2.0 |
| [`hdrhistogram`](https://github.com/HdrHistogram/HdrHistogram_rust) 7.5 | Latency histograms (1 µs to 60 s, 3 significant digits) | MIT or Apache-2.0 |
| [`lru`](https://github.com/jeromefroe/lru-rs) 0.18 | The result cache's LRU | MIT |
| [`core_affinity`](https://github.com/Elzair/core_affinity_rs) 0.8 | Pinning the workers to cores | MIT or Apache-2.0 |
| [`tikv-jemallocator`](https://github.com/tikv/jemallocator) 0.7 | The jemalloc allocator; bundles [jemalloc](https://github.com/jemalloc/jemalloc) (BSD-2-Clause) | MIT or Apache-2.0 |
| [`mimalloc`](https://github.com/purpleprotocol/mimalloc_rust) 0.1 | The mimalloc allocator; bundles [mimalloc](https://github.com/microsoft/mimalloc) (MIT) | MIT |
| [`libc`](https://github.com/rust-lang/libc) 0.2 | Thread ids, CPU clocks | MIT or Apache-2.0 |

Their own dependencies (`backtrace`, `symbolic-demangle`, `nix`, `smallvec`, `spin`...) are under the same licenses;
`cargo metadata` lists each one's. One, `r-efi`, offers LGPL-2.1 among MIT and Apache-2.0: it is only built for UEFI
targets, and MIT applies.

To add a dependency: check its license (and its dependencies') with `cargo metadata`, and add a row here.
