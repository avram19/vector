//! Shared Claude credential JSON parsing, used by both the Linux plaintext
//! `.credentials.json` reader and (eventually) the Windows equivalent.
//! Declared unconditionally (not cfg-gated per OS) so `cargo test` can run
//! this pure parser on any host, including macOS during development.

/// Parse the accessToken from a Claude credentials JSON blob. Two observed
/// shapes: { claudeAiOauth: { accessToken } } or { accessToken }.
/// Only consumed on Linux/Windows (macOS reads via Keychain instead), so
/// allow dead_code on platforms where nothing calls it.
#[allow(dead_code)]
pub(crate) fn extract_access_token(raw: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(raw.trim()).ok()?;
    v.get("claudeAiOauth").and_then(|o| o.get("accessToken")).and_then(|s| s.as_str())
        .or_else(|| v.get("accessToken").and_then(|s| s.as_str()))
        .map(|s| s.to_string())
}

#[cfg(test)]
mod cred_tests {
    use super::extract_access_token;
    #[test]
    fn reads_nested_and_flat_shapes() {
        assert_eq!(extract_access_token(r#"{"claudeAiOauth":{"accessToken":"tok1"}}"#), Some("tok1".into()));
        assert_eq!(extract_access_token(r#"{"accessToken":"tok2"}"#), Some("tok2".into()));
        assert_eq!(extract_access_token(r#"{"nope":1}"#), None);
    }
}
