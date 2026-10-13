//! gateway-bench: runs a load profile against Kitefin's inference gateway, see `gateway::cli()` and `--help`.

#[global_allocator]
static GLOBAL: gateway::alloc::Dispatch = gateway::alloc::Dispatch;

fn main() {
    gateway::cli()
}
