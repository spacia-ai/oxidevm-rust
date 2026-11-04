//! Linux integration for Rust programs that the OxideVM `oxidevm-rust` module runs as WebAssembly (`wasm32-wasip1`).
//!
//! Ordinary `std` file and stream APIs work through WASI. This crate adds what WASI Preview1 lacks: the process's real
//! identity and working directory now, and native Linux programs and VM sockets in later steps. Linking it also
//! restores the caller's working directory before `main`, which plain WASI programs do not get.
mod abi;
mod command;
pub mod net;
pub mod process;

use std::fmt;

/// A bridge call failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// The host answered with a WASI errno.
    Host(u32),
    /// The host is not running this program under the bridge (`NOSYS`), for example outside OxideVM.
    Unavailable,
    /// The host's answer broke the ABI.
    Protocol(&'static str),
    /// A command request broke a bound and was not started.
    InvalidCommand(&'static str),
    /// The child ran past its deadline and was killed.
    TimedOut,
    /// The child wrote more than its output limit and was killed.
    OutputLimit,
}

impl Error {
    fn from_errno(errno: u32) -> Self {
        match errno {
            abi::NOSYS => Self::Unavailable,
            abi::TIMEDOUT => Self::TimedOut,
            abi::TOOBIG => Self::OutputLimit,
            other => Self::Host(other),
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Host(errno) => write!(f, "the OxideVM host failed with WASI errno {errno}"),
            Self::Unavailable => f.write_str("the OxideVM bridge is not available to this program"),
            Self::Protocol(reason) => write!(f, "the OxideVM bridge broke its ABI: {reason}"),
            Self::InvalidCommand(reason) => write!(f, "invalid native command: {reason}"),
            Self::TimedOut => {
                f.write_str("the native command ran past its deadline and was killed")
            }
            Self::OutputLimit => {
                f.write_str("the native command exceeded its output limit and was killed")
            }
        }
    }
}

impl std::error::Error for Error {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outside_oxidevm_every_call_is_unavailable() {
        assert_eq!(process::info(), Err(Error::Unavailable));
        assert_eq!(process::cwd(), Err(Error::Unavailable));
    }

    #[test]
    fn errors_name_their_cause() {
        assert_eq!(Error::from_errno(8), Error::Host(8));
        assert!(Error::Unavailable.to_string().contains("not available"));
        assert!(
            Error::Protocol("x")
                .to_string()
                .contains("broke its ABI: x")
        );
    }
}
