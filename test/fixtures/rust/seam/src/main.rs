//! SL-01 host-seam spike: runs a native Linux program through the synchronous prototype import
//! `oxidevm_bridge_spike.run` and relays its result. This is a feasibility fixture, not the v1 bridge ABI.
//!
//!   seam <absolute-executable> [args...]
//!
//! Standard input is read to its end and fed to the child; the child's standard output goes to standard output, its
//! standard error to standard error, and one line `seam: child=<pid> status=<raw wait status>` to standard error. The
//! fixture exits with the child's exit code, or 128+signal when a signal ended the child.
use std::io::{self, Read, Write};
use std::process::ExitCode;

mod spike {
    #![allow(unsafe_code)]
    // The only unsafe code in the fixture: the call across the Wasm import boundary. Every pointer is derived from a
    // live slice whose length is passed beside it, and the host checks every range against linear memory.
    #[link(wasm_import_module = "oxidevm_bridge_spike")]
    unsafe extern "C" {
        #[link_name = "run"]
        fn raw_run(
            argv: *const u8,
            argv_len: usize,
            input: *const u8,
            input_len: usize,
            output: *mut u8,
            output_cap: usize,
            result: *mut u32,
        ) -> u32;
    }

    pub struct Outcome {
        pub pid: u32,
        pub status: u32,
        pub stdout: Vec<u8>,
        pub stderr: Vec<u8>,
    }

    /// `argv` is NUL-separated; the reply is `[pid, status, stdout_len, stderr_len]` and the output bytes, stdout first.
    pub fn run(argv: &[u8], input: &[u8], capacity: usize) -> Result<Outcome, u32> {
        let mut output = vec![0_u8; capacity];
        let mut result = [0_u32; 4];
        // SAFETY: each pointer/length pair comes from a slice that outlives the call.
        let errno = unsafe {
            raw_run(
                argv.as_ptr(),
                argv.len(),
                input.as_ptr(),
                input.len(),
                output.as_mut_ptr(),
                output.len(),
                result.as_mut_ptr(),
            )
        };
        if errno != 0 {
            return Err(errno);
        }
        let [pid, status, out_len, err_len] = result.map(|value| value as usize);
        if out_len
            .checked_add(err_len)
            .is_none_or(|total| total > capacity)
        {
            return Err(75);
        }
        let stderr = output.split_off(out_len);
        let stderr = stderr
            .get(..err_len)
            .map(<[u8]>::to_vec)
            .unwrap_or_default();
        Ok(Outcome {
            pid: pid as u32,
            status: status as u32,
            stdout: output,
            stderr,
        })
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: seam <absolute-executable> [args...]");
        return ExitCode::from(2);
    }
    let argv = args.join("\0").into_bytes();
    let mut input = Vec::new();
    if std::env::var_os("SEAM_NO_INPUT").is_none() && io::stdin().read_to_end(&mut input).is_err() {
        eprintln!("seam: cannot read standard input");
        return ExitCode::from(1);
    }
    match spike::run(&argv, &input, 2 * 1024 * 1024) {
        Ok(outcome) => {
            let written = io::stdout()
                .write_all(&outcome.stdout)
                .and_then(|()| io::stdout().flush());
            let _ = io::stderr().write_all(&outcome.stderr);
            eprintln!("seam: child={} status={}", outcome.pid, outcome.status);
            if written.is_err() {
                return ExitCode::from(1);
            }
            let signal = outcome.status & 0x7f;
            ExitCode::from(if signal == 0 {
                ((outcome.status >> 8) & 0xff) as u8
            } else {
                128 + signal as u8
            })
        }
        Err(errno) => {
            eprintln!("seam: native run failed with errno {errno}");
            ExitCode::from(1)
        }
    }
}
