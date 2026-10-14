//! The memory allocator, picked when the process starts from $GATEWAY_ALLOCATOR: `system` (glibc's malloc),
//! `jemalloc` or `mimalloc`. One binary for the three, so every commit of the story runs the same build.
//!
//! The choice is read before the first allocation and never changes, so memory is always freed by the allocator that
//! allocated it.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicU8, Ordering};

use mimalloc::MiMalloc;
use tikv_jemallocator::Jemalloc;

pub struct Dispatch;

const UNSET: u8 = 0;
const SYSTEM: u8 = 1;
const JEMALLOC: u8 = 2;
const MIMALLOC: u8 = 3;

static CHOICE: AtomicU8 = AtomicU8::new(UNSET);

#[cold]
fn choose() -> u8 {
    // getenv doesn't allocate
    let value = unsafe { libc::getenv(c"GATEWAY_ALLOCATOR".as_ptr()) };
    let choice = if value.is_null() {
        SYSTEM
    } else {
        match unsafe { std::ffi::CStr::from_ptr(value) }.to_bytes() {
            b"jemalloc" => JEMALLOC,
            b"mimalloc" => MIMALLOC,
            _ => SYSTEM,
        }
    };
    // The first thread to allocate decides (in practice, the main thread before any other starts)
    match CHOICE.compare_exchange(UNSET, choice, Ordering::AcqRel, Ordering::Acquire) {
        Ok(_) => choice,
        Err(current) => current,
    }
}

#[inline(always)]
fn current() -> u8 {
    match CHOICE.load(Ordering::Relaxed) {
        UNSET => choose(),
        c => c,
    }
}

pub fn name() -> &'static str {
    match current() {
        JEMALLOC => "jemalloc",
        MIMALLOC => "mimalloc",
        _ => "system",
    }
}

unsafe impl GlobalAlloc for Dispatch {
    #[inline]
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        match current() {
            JEMALLOC => Jemalloc.alloc(layout),
            MIMALLOC => MiMalloc.alloc(layout),
            _ => System.alloc(layout),
        }
    }

    #[inline]
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        match current() {
            JEMALLOC => Jemalloc.alloc_zeroed(layout),
            MIMALLOC => MiMalloc.alloc_zeroed(layout),
            _ => System.alloc_zeroed(layout),
        }
    }

    #[inline]
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        match current() {
            JEMALLOC => Jemalloc.dealloc(ptr, layout),
            MIMALLOC => MiMalloc.dealloc(ptr, layout),
            _ => System.dealloc(ptr, layout),
        }
    }

    #[inline]
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        match current() {
            JEMALLOC => Jemalloc.realloc(ptr, layout, new_size),
            MIMALLOC => MiMalloc.realloc(ptr, layout, new_size),
            _ => System.realloc(ptr, layout, new_size),
        }
    }
}
