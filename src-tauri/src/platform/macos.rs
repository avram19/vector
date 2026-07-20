use std::path::{Path, PathBuf};
use std::process::Command;

pub fn open_path(target: &str) -> std::io::Result<()> {
    Command::new("/usr/bin/open").arg(target).spawn().map(|_| ())
}

pub fn reveal_in_file_manager(path: &Path) -> Result<(), String> {
    let open_bin = crate::config::which_path("open")
        .unwrap_or_else(|| PathBuf::from("/usr/bin/open"));
    Command::new(open_bin).arg("-R").arg(path).spawn().map(|_| ()).map_err(|e| e.to_string())
}

pub fn open_default_app(path: &Path) -> Result<(), String> {
    let open_bin = crate::config::which_path("open")
        .unwrap_or_else(|| PathBuf::from("/usr/bin/open"));
    Command::new(open_bin).arg(path).spawn().map(|_| ()).map_err(|e| e.to_string())
}

pub fn process_cwd(pid: u32) -> Option<String> {
    use std::ffi::CStr;
    use std::mem;
    use std::os::raw::{c_int, c_void, c_char};

    // PROC_PIDVNODEPATHINFO (flavor 9) returns a proc_vnodepathinfo struct
    // whose pvi_cdir.vip_path field holds the cwd as a null-terminated C string.
    // libproc already links libproc.dylib so proc_pidinfo is available as an extern symbol.
    extern "C" {
        fn proc_pidinfo(
            pid: c_int,
            flavor: c_int,
            arg: u64,
            buffer: *mut c_void,
            buffersize: c_int,
        ) -> c_int;
    }

    const PROC_PIDVNODEPATHINFO: c_int = 9;
    const MAXPATHLEN: usize = 1024;

    // Mirror the macOS proc_vnodepathinfo ABI, verified against bindgen output
    // from libproc-0.14.11/docs_rs/osx_libproc_bindings.rs:
    //
    //   vinfo_stat:        136 bytes  (XNU struct, computed from all fields)
    //   vnode_info:        152 bytes  (vinfo_stat + vi_type:i32 + vi_pad:i32 + vi_fsid:fsid_t[8])
    //   vnode_info_path:  1176 bytes  (vnode_info[152] + vip_path[1024])
    //   proc_vnodepathinfo: 2352 bytes (pvi_cdir + pvi_rdir, both vnode_info_path)
    //
    // vip_path is at byte offset 152 within vnode_info_path.
    #[repr(C)]
    struct VnodeInfoPath {
        _vip_vi: [u8; 152],             // vnode_info (opaque)
        vip_path: [c_char; MAXPATHLEN],
    }

    #[repr(C)]
    struct ProcVnodePathInfo {
        pvi_cdir: VnodeInfoPath,
        _pvi_rdir: VnodeInfoPath,
    }

    let mut info: ProcVnodePathInfo = unsafe { mem::zeroed() };
    let ret = unsafe {
        proc_pidinfo(
            pid as c_int,
            PROC_PIDVNODEPATHINFO,
            0,
            &mut info as *mut _ as *mut c_void,
            mem::size_of::<ProcVnodePathInfo>() as c_int,
        )
    };
    if ret <= 0 {
        return None;
    }
    let cstr = unsafe { CStr::from_ptr(info.pvi_cdir.vip_path.as_ptr()) };
    cstr.to_str().ok().map(|s| s.to_string())
}

pub fn clipboard_file_paths() -> Vec<String> {
    // Existing NSPasteboard reader lives in crate::clipboard::macos.
    crate::clipboard::macos_file_paths()
}

pub fn extra_path_dirs(home: &Path) -> Vec<PathBuf> {
    vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
        home.join(".local/bin"),
        home.join(".cargo/bin"),
        home.join(".npm-global/bin"),
        home.join(".bun/bin"),
    ]
}
