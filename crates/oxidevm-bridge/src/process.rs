//! This process's identity and, from a later release step, native Linux programs it starts.
use crate::{Error, abi};
use std::path::PathBuf;

/// The Linux identity of this process, as the VM reports it (not the values of `std::process::id()`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProcessInfo {
    pub pid: u32,
    /// The parent process when this one started, or `None` when it has none.
    pub parent: Option<u32>,
    pub uid: u32,
    pub gid: u32,
}

/// The real Linux identity of this process.
pub fn info() -> Result<ProcessInfo, Error> {
    let [pid, parent, uid, gid] = abi::process_info().map_err(Error::from_errno)?;
    if pid == 0 {
        return Err(Error::Protocol("the host reported process id 0"));
    }
    Ok(ProcessInfo {
        pid,
        parent: (parent != 0).then_some(parent),
        uid,
        gid,
    })
}

/// The directory the caller ran this program in. wasi-libc's own `current_dir()` agrees with it only after the bridge
/// restored it (when the directory exists and is reachable).
pub fn cwd() -> Result<PathBuf, Error> {
    let mut buffer = vec![0_u8; 4096];
    let length = abi::process_cwd(&mut buffer).map_err(Error::from_errno)?;
    let bytes = buffer
        .get(..length)
        .ok_or(Error::Protocol("the working directory exceeds 4096 bytes"))?;
    let text = std::str::from_utf8(bytes)
        .map_err(|_| Error::Protocol("the working directory is not UTF-8"))?;
    if !text.starts_with('/') {
        return Err(Error::Protocol("the working directory is not absolute"));
    }
    Ok(PathBuf::from(text))
}
