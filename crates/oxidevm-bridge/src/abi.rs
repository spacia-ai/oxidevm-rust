//! The `oxidevm_bridge_v1` imports. This is the crate's only unsafe code: each call passes pointers
//! derived from live Rust values together with their lengths, and the host checks every range against linear memory
//! before it reads or writes anything. On targets other than wasm32 the functions report `NOSYS`, so the crate's pure
//! parts build and test natively.
#![allow(unsafe_code)]

/// WASI errno: function not supported.
pub(crate) const NOSYS: u32 = 52;

#[cfg(target_arch = "wasm32")]
mod imports {
    #[link(wasm_import_module = "oxidevm_bridge_v1")]
    unsafe extern "C" {
        pub(crate) fn process_info(out: *mut u32) -> u32;
        pub(crate) fn process_cwd(buffer: *mut u8, len: u32, out_len: *mut u32) -> u32;
    }
}

/// `[pid, parent, uid, gid]`, or a WASI errno.
pub(crate) fn process_info() -> Result<[u32; 4], u32> {
    #[cfg(target_arch = "wasm32")]
    {
        let mut out = [0_u32; 4];
        // SAFETY: `out` is a live, writable array of four u32 for the duration of the call.
        let errno = unsafe { imports::process_info(out.as_mut_ptr()) };
        if errno == 0 { Ok(out) } else { Err(errno) }
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        Err(NOSYS)
    }
}

/// Copies the current directory into `buffer`; returns its full length (which may exceed the buffer), or a WASI errno.
pub(crate) fn process_cwd(buffer: &mut [u8]) -> Result<usize, u32> {
    #[cfg(target_arch = "wasm32")]
    {
        let mut length = 0_u32;
        let capacity = u32::try_from(buffer.len()).map_err(|_| 28_u32)?;
        // SAFETY: `buffer` is writable for `capacity` bytes and `length` is a live u32, both for the call.
        let errno = unsafe { imports::process_cwd(buffer.as_mut_ptr(), capacity, &mut length) };
        if errno == 0 {
            usize::try_from(length).map_err(|_| 61_u32)
        } else {
            Err(errno)
        }
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = buffer;
        Err(NOSYS)
    }
}

/// Runs before `main` (wasm-ld collects `.init_array` into `__wasm_call_ctors`): WASI Preview1 has no working
/// directory, and wasi-libc starts every program at `/`, so the bridge moves it to the caller's real directory.
#[cfg(target_arch = "wasm32")]
#[used]
#[unsafe(link_section = ".init_array")]
static RESTORE_CWD: extern "C" fn() = restore_cwd;

#[cfg(target_arch = "wasm32")]
extern "C" fn restore_cwd() {
    if let Ok(cwd) = crate::process::cwd() {
        // A directory the program cannot enter leaves wasi-libc at `/`; `process::cwd()` still reports the real one.
        let _ = std::env::set_current_dir(cwd);
    }
}
