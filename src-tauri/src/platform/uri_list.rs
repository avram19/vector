//! Shared parser for the freedesktop `text/uri-list` clipboard/drop format.
//! Declared unconditionally (not per-OS) so its unit tests run on every host,
//! including macOS, even though it's only consumed by `platform::linux`.

/// Parse a freedesktop `text/uri-list`: skip blank/comment lines, keep only
/// `file://` URIs, strip the scheme+host, and percent-decode the path.
///
/// Only consumed by `platform::linux`; on other targets these functions
/// exist solely so their `#[cfg(test)]` unit tests below run everywhere.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn parse_uri_list(raw: &str) -> Vec<String> {
    raw.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter_map(|l| l.strip_prefix("file://"))
        // Drop an optional host component: file://host/path -> /path
        .map(|rest| match rest.find('/') { Some(i) => &rest[i..], None => rest })
        .map(percent_decode)
        .collect()
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(byte) = s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::{parse_uri_list, percent_decode};
    #[test]
    fn parses_and_percent_decodes_file_uris() {
        let input = "file:///home/u/a%20b.txt\r\nfile:///tmp/c.rs\r\n# comment\r\n";
        assert_eq!(
            parse_uri_list(input),
            vec!["/home/u/a b.txt".to_string(), "/tmp/c.rs".to_string()]
        );
    }
    #[test]
    fn ignores_non_file_and_blank_lines() {
        let input = "\r\nhttp://x/y\r\nfile:///z\r\n";
        assert_eq!(parse_uri_list(input), vec!["/z".to_string()]);
    }
    #[test]
    fn does_not_panic_on_percent_before_multibyte() {
        // A literal '%' before a multi-byte char must not panic; it falls
        // through and is preserved rather than decoded.
        assert_eq!(percent_decode("%aé"), "%aé".to_string());
    }
}
