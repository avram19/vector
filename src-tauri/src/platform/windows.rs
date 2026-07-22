use std::path::{Path, PathBuf};

pub fn open_path(target: &str) -> std::io::Result<()> {
    // The empty "" is `start`'s title argument — required so a quoted path
    // isn't consumed as the window title.
    crate::config::silent_command("cmd")
        .args(["/C", "start", "", target])
        .spawn()
        .map(|_| ())
}

/// Windows: `explorer /select,<path>` highlights the file in a new Explorer
/// window. explorer.exe returns a nonzero exit code even on success, so we
/// spawn-and-forget without checking status.
pub fn reveal_in_file_manager(path: &Path) -> Result<(), String> {
    crate::config::silent_command("explorer.exe")
        .arg(format!("/select,{}", path.display()))
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Windows: `cmd /C start "" <path>` opens the path in its default handler.
pub fn open_default_app(path: &Path) -> Result<(), String> {
    crate::config::silent_command("cmd")
        .args(["/C", "start", ""])
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Extra PATH dirs where Windows package managers drop agent/git shims. macOS
/// GUI apps start with a minimal PATH; Windows GUI apps inherit the fuller user
/// PATH, but these cover common setups where a shim dir isn't on PATH yet.
pub fn extra_path_dirs(home: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("npm")); // npm global bin (.cmd shims)
    }
    dirs.push(home.join(".cargo").join("bin"));
    dirs.push(home.join(".bun").join("bin"));
    dirs.push(home.join("scoop").join("shims"));
    if let Some(programdata) = std::env::var_os("ProgramData") {
        dirs.push(PathBuf::from(programdata).join("chocolatey").join("bin"));
    }
    if let Some(pf) = std::env::var_os("ProgramFiles") {
        dirs.push(PathBuf::from(pf).join("Git").join("cmd")); // Git for Windows
    }
    dirs
}
/// Read another process's current working directory by walking its PEB. There
/// is no public Win32 API for this, so we use the documented approach:
/// `NtQueryInformationProcess(ProcessBasicInformation)` for the PEB base, then
/// `ReadProcessMemory` to follow PEB → RTL_USER_PROCESS_PARAMETERS →
/// CurrentDirectory.DosPath (a UNICODE_STRING). Offsets are the x64 ABI (our
/// only target). Best-effort — any failure returns None.
pub fn process_cwd(pid: u32) -> Option<String> {
    use std::os::raw::c_void;

    type Handle = *mut c_void;
    const PROCESS_QUERY_INFORMATION: u32 = 0x0400;
    const PROCESS_VM_READ: u32 = 0x0010;

    #[repr(C)]
    struct ProcessBasicInformation {
        _reserved1: *mut c_void,
        peb_base_address: *mut c_void,
        _reserved2: [*mut c_void; 2],
        _unique_process_id: usize,
        _reserved3: *mut c_void,
    }

    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
        fn CloseHandle(h: Handle) -> i32;
        fn ReadProcessMemory(
            h: Handle,
            base: *const c_void,
            buf: *mut c_void,
            size: usize,
            read: *mut usize,
        ) -> i32;
    }
    #[link(name = "ntdll")]
    extern "system" {
        fn NtQueryInformationProcess(
            h: Handle,
            class: u32,
            info: *mut c_void,
            len: u32,
            ret_len: *mut u32,
        ) -> i32;
    }

    unsafe {
        let h = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid);
        if h.is_null() {
            return None;
        }
        // Closure so we CloseHandle on every exit path.
        let out = (|| -> Option<String> {
            let read_at = |addr: usize, buf: *mut c_void, size: usize| -> bool {
                let mut got = 0usize;
                ReadProcessMemory(h, addr as *const c_void, buf, size, &mut got) != 0 && got == size
            };

            let mut pbi: ProcessBasicInformation = std::mem::zeroed();
            let mut ret_len = 0u32;
            // ProcessBasicInformation class = 0.
            if NtQueryInformationProcess(
                h,
                0,
                &mut pbi as *mut _ as *mut c_void,
                std::mem::size_of::<ProcessBasicInformation>() as u32,
                &mut ret_len,
            ) != 0
            {
                return None;
            }
            let peb = pbi.peb_base_address as usize;
            if peb == 0 {
                return None;
            }

            let ptr_size = std::mem::size_of::<usize>();
            // x64 offsets:
            //   PEB.ProcessParameters                                  @ 0x20
            //   RTL_USER_PROCESS_PARAMETERS.CurrentDirectory.DosPath   @ 0x38
            //     UNICODE_STRING { u16 Length; u16 MaxLength; PWSTR Buffer; }
            //       Length @ +0x00, Buffer ptr @ +0x08
            let mut params: usize = 0;
            if !read_at(peb + 0x20, &mut params as *mut _ as *mut c_void, ptr_size) || params == 0 {
                return None;
            }
            let mut len_u16: u16 = 0;
            if !read_at(params + 0x38, &mut len_u16 as *mut _ as *mut c_void, 2) {
                return None;
            }
            if len_u16 == 0 || len_u16 > 0x7ffe {
                return None;
            }
            let mut buf_ptr: usize = 0;
            if !read_at(params + 0x40, &mut buf_ptr as *mut _ as *mut c_void, ptr_size) || buf_ptr == 0 {
                return None;
            }
            let n_chars = (len_u16 as usize) / 2;
            let mut wbuf: Vec<u16> = vec![0u16; n_chars];
            if !read_at(buf_ptr, wbuf.as_mut_ptr() as *mut c_void, len_u16 as usize) {
                return None;
            }
            let s = String::from_utf16_lossy(&wbuf);
            let trimmed = s.trim_end_matches(['\\', '/']);
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        })();
        CloseHandle(h);
        out
    }
}
pub fn clipboard_file_paths() -> Vec<String> { todo!("Milestone 2: CF_HDROP") }
pub fn clipboard_file_paths() -> Vec<String> { todo!("Milestone 2: CF_HDROP") }
pub fn read_claude_credential(_profile_id: Option<&str>) -> Option<String> { todo!("Milestone 2: plaintext .credentials.json") }
