//! Single cfg-dispatch point for leaf OS operations. Each OS module implements
//! the same surface; the compiler enforces completeness, so a missing platform
//! impl is a build error rather than a silent parity gap.

mod uri_list;
mod creds;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::*;

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub use windows::*;
