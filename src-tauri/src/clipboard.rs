//! Reading file paths from the system clipboard.
//!
//! When a file is copied in Finder, the macOS pasteboard carries the file's
//! *path*, not its bytes. The webview's HTML5 clipboard API doesn't expose that
//! path (same reason `dragDropEnabled` is needed for drops), so the Cmd/Ctrl+V
//! paste handler reads NSPasteboard natively here. This is the copy-paste analog
//! of the drag-and-drop file-path insertion.

/// Absolute paths of any files currently on the clipboard. Empty when the
/// clipboard holds no files (e.g. plain text) or on non-macOS platforms.
#[tauri::command]
pub fn read_clipboard_file_paths() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        macos::file_paths()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Vec::new()
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use objc2::runtime::AnyObject;
    #[allow(deprecated)]
    use objc2_app_kit::NSFilenamesPboardType;
    use objc2_app_kit::NSPasteboard;
    use objc2_foundation::{NSArray, NSString};

    pub fn file_paths() -> Vec<String> {
        // SAFETY: read-only AppKit pasteboard access. We never mutate the
        // pasteboard, and all returned objects are owned `Retained` handles.
        unsafe {
            let pasteboard = NSPasteboard::generalPasteboard();
            // `NSFilenamesPboardType` is the classic Finder-copy type: its
            // property list is an array of POSIX path strings. Deprecated in
            // favour of per-item `NSPasteboardTypeFileURL`, but it returns every
            // copied path in one array, which is exactly what we want.
            #[allow(deprecated)]
            let Some(plist) = pasteboard.propertyListForType(NSFilenamesPboardType) else {
                return Vec::new();
            };
            let Ok(array) = plist.downcast::<NSArray<AnyObject>>() else {
                return Vec::new();
            };
            let mut paths = Vec::with_capacity(array.count());
            for i in 0..array.count() {
                let item = array.objectAtIndex(i);
                if let Ok(s) = item.downcast::<NSString>() {
                    paths.push(s.to_string());
                }
            }
            paths
        }
    }
}
