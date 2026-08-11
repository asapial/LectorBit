//! Tracing-subscriber layer and helper functions that mask sensitive substrings
//! in events.
//!
//! Privacy posture for LectorBit (PRD §15.1):
//!
//! - User file paths are sensitive (they may reveal personal folder names).
//! - Bearer tokens / API keys must never end up in a log or diagnostic bundle.
//! - Emails are user-identifying — redact them.
//!
//! The layer is intentionally conservative: when in doubt, redact. The output
//! is human-readable (it just swaps substrings for `[REDACTED]`), which keeps
//! log scanning useful while preventing accidental leakage.
//!
//! Usage from the Tauri shell:
//!
//! ```ignore
//! use lectorbit_db::redaction::RedactingMakeWriter;
//! use std::io::stderr;
//! use tracing_subscriber::layer::SubscriberExt;
//! use tracing_subscriber::util::SubscriberInitExt;
//! use tracing_subscriber::EnvFilter;
//!
//! tracing_subscriber::registry()
//!     .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
//!     .with(
//!         tracing_subscriber::fmt::layer()
//!             .with_writer(RedactingMakeWriter::new(stderr))
//!             .with_target(false),
//!     )
//!     .init();
//! ```

use std::io::{self, Stderr, Write};
use std::sync::{Arc, Mutex, OnceLock};

use regex::Regex;
use tracing::field::{Field, Visit};

/// Static regex cache — compiled lazily, used in `Visit::record_str`.
fn patterns() -> &'static Patterns {
    static PATTERNS: OnceLock<Patterns> = OnceLock::new();
    PATTERNS.get_or_init(|| Patterns {
        windows_abs: Regex::new(r#"(?i)([A-Za-z]:\\(?:[^\\\s'"<>|*?]+\\?)*)"#)
            .expect("windows path regex"),
        posix_abs: Regex::new(r#"(/[^\s'"<>|*?]+(?:/[^\s'"<>|*?]+)*)"#)
            .expect("posix path regex"),
        bearer: Regex::new(r#"(?i)\b(?:Bearer|Token|Api[_-]?Key)\s+[A-Za-z0-9._\-]{8,}"#)
            .expect("bearer token regex"),
        email: Regex::new(r#"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}"#)
            .expect("email regex"),
    })
}

struct Patterns {
    windows_abs: Regex,
    posix_abs: Regex,
    bearer: Regex,
    email: Regex,
}

/// Mask `input` by replacing every sensitive pattern with `[REDACTED]`.
fn redact_str(input: &str) -> String {
    let p = patterns();
    let mut s = p.email.replace_all(input, "[REDACTED]").into_owned();
    s = p.bearer.replace_all(&s, "[REDACTED]").into_owned();
    s = p.windows_abs.replace_all(&s, "[REDACTED]").into_owned();
    s = p.posix_abs.replace_all(&s, "[REDACTED]").into_owned();
    s
}

/// Public function for code that doesn't go through the layer system
/// (e.g. the diagnostics bundle builder, feature 14).
pub fn redact(input: &str) -> String {
    redact_str(input)
}

/// A `MakeWriter` wrapper that redacts each formatted line before writing it.
///
/// Use it on `fmt::Layer::with_writer` so every log line is masked in-flight.
#[derive(Debug, Clone)]
pub struct RedactingMakeWriter<W> {
    inner: Arc<Mutex<W>>,
}

impl RedactingMakeWriter<Stderr> {
    pub fn stderr() -> Self {
        Self::new(io::stderr())
    }
}

impl<W: Write + Send> RedactingMakeWriter<W> {
    pub fn new(inner: W) -> Self {
        Self {
            inner: Arc::new(Mutex::new(inner)),
        }
    }
}

impl<'a, W: Write + Send + 'a> tracing_subscriber::fmt::MakeWriter<'a>
    for RedactingMakeWriter<W>
{
    type Writer = RedactingWriter<W>;

    fn make_writer(&'a self) -> Self::Writer {
        RedactingWriter {
            inner: self.inner.clone(),
        }
    }
}

pub struct RedactingWriter<W> {
    inner: Arc<Mutex<W>>,
}

impl<W: Write> Write for RedactingWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let s = std::str::from_utf8(buf)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        let redacted = redact_str(s);
        let bytes = redacted.as_bytes();
        // Write may write fewer bytes than requested. We loop until done.
        let mut written = 0;
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| io::Error::new(io::ErrorKind::Other, "writer mutex poisoned"))?;
        while written < bytes.len() {
            let n = guard.write(&bytes[written..])?;
            if n == 0 {
                break;
            }
            written += n;
        }
        // Report the number of *original* bytes consumed (so the fmt layer
        // can advance its cursor even if the redacted form is longer).
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner
            .lock()
            .map_err(|_| io::Error::new(io::ErrorKind::Other, "writer mutex poisoned"))?
            .flush()
    }
}

/// Visit an event's fields and return a redacted projection. Used by tests
/// and by the diagnostics bundle builder.
pub fn redact_event_fields(event: &tracing::Event<'_>) -> Vec<(String, String)> {
    let mut visitor = RedactingVisitor::default();
    event.record(&mut visitor);
    visitor.0
}

#[derive(Default)]
struct RedactingVisitor(Vec<(String, String)>);

impl Visit for RedactingVisitor {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.0.push((field.name().to_string(), redact_str(value)));
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        let formatted = format!("{value:?}");
        self.0.push((field.name().to_string(), redact_str(&formatted)));
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.0.push((field.name().to_string(), value.to_string()));
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.0.push((field.name().to_string(), value.to_string()));
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.0.push((field.name().to_string(), value.to_string()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tracing_subscriber::fmt::MakeWriter;

    #[test]
    fn redacts_windows_paths() {
        let s = "opening C:\\Users\\Alice\\Videos\\lecture.mp4 for transcribe";
        let r = redact(s);
        assert!(!r.contains("Alice"));
        assert!(r.contains("[REDACTED]"));
    }

    #[test]
    fn redacts_posix_paths() {
        let s = "scanned /home/bob/media/intro.mkv and /home/bob/media/outro.mkv";
        let r = redact(s);
        assert!(!r.contains("/home/bob"));
        assert!(r.contains("[REDACTED]"));
    }

    #[test]
    fn redacts_emails() {
        let r = redact("user [email protected] requested sync");
        assert!(!r.contains("@example.com"));
        assert!(r.contains("[REDACTED]"));
    }

    #[test]
    fn redacts_bearer_tokens() {
        let r = redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz");
        assert!(!r.contains("abcdefghij"));
        assert!(r.contains("[REDACTED]"));
    }

    #[test]
    fn leaves_safe_text_alone() {
        let s = "scanned 3 media files; ok";
        assert_eq!(redact(s), s);
    }

    #[test]
    fn handles_multiple_patterns_in_one_string() {
        let s = "auth failed for [email protected] with Bearer abcdefghijklmno at C:\\Users\\Alice";
        let r = redact(s);
        assert!(!r.contains("@example.com"));
        assert!(!r.contains("Bearer abcdef"));
        assert!(!r.contains("Alice"));
    }

    #[test]
    fn make_writer_redacts_a_line() {
        struct Shared(Arc<Mutex<Vec<u8>>>);
        impl Write for Shared {
            fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        let buf: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let shared = Shared(buf.clone());
        let mw = RedactingMakeWriter::new(shared);
        let mut w = mw.make_writer();
        w.write_all(b"scanned /home/bob/secret.mp4 done\n").unwrap();
        w.flush().unwrap();
        let out = String::from_utf8(buf.lock().unwrap().clone()).unwrap();
        assert!(!out.contains("/home/bob"));
        assert!(out.contains("[REDACTED]"));
    }

    #[test]
    fn layer_redacts_event_fields_in_flight() {
        // End-to-end smoke test: wire a real tracing layer through a
        // `RedactingMakeWriter` over a `Vec<u8>` and confirm that a logged
        // event containing a sensitive string is masked before it lands in
        // the sink. This exercises the same code path the Tauri shell uses.
        use std::sync::{Arc, Mutex};
        use tracing_subscriber::layer::SubscriberExt;

        let buf: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = BufferSink(buf.clone());
        let make_writer = RedactingMakeWriter::new(sink);

        let subscriber = tracing_subscriber::registry()
            .with(
                tracing_subscriber::fmt::layer()
                    .with_writer(make_writer)
                    .with_ansi(false)
                    .with_target(false)
                    .without_time(),
            )
            .with(tracing_subscriber::EnvFilter::new("info"));

        // Run the event under a scoped subscriber so we don't disturb the
        // process-global default subscriber.
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(path = "C:\\Users\\Alice\\lecture.mp4", count = 3, "scanned");
        });

        let rendered = String::from_utf8(buf.lock().unwrap().clone()).unwrap();
        assert!(!rendered.contains("Alice"), "path leaked into log: {rendered}");
        assert!(
            rendered.contains("[REDACTED]"),
            "redaction marker missing: {rendered}"
        );
        assert!(rendered.contains("count=3"), "non-string field lost: {rendered}");
    }

    /// Test sink: collects bytes into a shared `Vec<u8>` for assertion.
    struct BufferSink(Arc<Mutex<Vec<u8>>>);
    impl Write for BufferSink {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
}
