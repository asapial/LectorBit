//! Token-gated, range-aware media responses for the in-app video element.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{IpAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use tauri::http::StatusCode;
#[cfg(test)]
use tauri::http::{header, Method, Request, Response};
use uuid::Uuid;

#[derive(Clone)]
pub struct EmbeddedMediaRegistry {
    grants: Arc<RwLock<HashMap<String, MediaGrant>>>,
    origin: Arc<str>,
}

#[derive(Clone)]
struct MediaGrant {
    path: PathBuf,
    content_type: &'static str,
}

impl EmbeddedMediaRegistry {
    /// Starts a loopback-only HTTP origin for WebView media requests.
    ///
    /// WebView2 does not reliably hand media range requests to custom URI
    /// protocol handlers. A real ephemeral HTTP origin preserves browser media
    /// semantics while opaque grants keep filesystem paths private.
    pub fn start() -> std::io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        let port = listener.local_addr()?.port();
        let registry = Self {
            grants: Arc::new(RwLock::new(HashMap::new())),
            origin: Arc::from(format!("http://127.0.0.1:{port}")),
        };
        let server_registry = registry.clone();
        std::thread::Builder::new()
            .name("lectorbit-media".into())
            .spawn(move || serve_loopback(listener, server_registry))?;
        Ok(registry)
    }

    pub fn grant(&self, canonical_path: PathBuf) -> Option<(String, String)> {
        if !canonical_path.is_absolute() || !canonical_path.is_file() {
            return None;
        }
        let token = Uuid::now_v7().simple().to_string();
        let content_type = media_type(&canonical_path);
        self.grants.write().ok()?.insert(
            token.clone(),
            MediaGrant {
                path: canonical_path,
                content_type,
            },
        );
        Some((token.clone(), self.media_url(&token)))
    }

    pub fn revoke(&self, token: &str) {
        if let Ok(mut grants) = self.grants.write() {
            grants.remove(token);
        }
    }

    #[cfg(test)]
    fn respond(&self, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
        let token = request.uri().path().trim_matches('/');
        if token.len() != 32 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return empty_response(StatusCode::NOT_FOUND);
        }
        let Some(grant) = self
            .grants
            .read()
            .ok()
            .and_then(|grants| grants.get(token).cloned())
        else {
            return empty_response(StatusCode::NOT_FOUND);
        };
        serve_file(&grant, &request)
    }

    fn media_url(&self, token: &str) -> String {
        format!("{}/{token}", self.origin)
    }
}

impl Default for EmbeddedMediaRegistry {
    fn default() -> Self {
        Self {
            grants: Arc::new(RwLock::new(HashMap::new())),
            origin: Arc::from("http://127.0.0.1:0"),
        }
    }
}

fn serve_loopback(listener: TcpListener, registry: EmbeddedMediaRegistry) {
    for connection in listener.incoming() {
        let Ok(stream) = connection else {
            continue;
        };
        if !stream
            .peer_addr()
            .is_ok_and(|address| address.ip() == IpAddr::from([127, 0, 0, 1]))
        {
            continue;
        }
        let request_registry = registry.clone();
        let _ = std::thread::Builder::new()
            .name("lectorbit-media-request".into())
            .spawn(move || {
                let _ = serve_connection(stream, &request_registry);
            });
    }
}

fn serve_connection(
    mut stream: TcpStream,
    registry: &EmbeddedMediaRegistry,
) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    stream.set_write_timeout(Some(Duration::from_secs(120)))?;

    let mut request_line = String::new();
    let mut range = None;
    {
        let mut reader = BufReader::new(&stream);
        if reader.read_line(&mut request_line)? > 8 * 1024 {
            return write_empty_http(&mut stream, StatusCode::BAD_REQUEST, None);
        }
        let mut total_header_bytes = request_line.len();
        loop {
            let mut line = String::new();
            let read = reader.read_line(&mut line)?;
            if read == 0 || line == "\r\n" || line == "\n" {
                break;
            }
            total_header_bytes += read;
            if total_header_bytes > 32 * 1024 {
                return write_empty_http(&mut stream, StatusCode::BAD_REQUEST, None);
            }
            if let Some((name, value)) = line.split_once(':') {
                if name.trim().eq_ignore_ascii_case("range") {
                    range = Some(value.trim().to_owned());
                }
            }
        }
    }

    let mut parts = request_line.split_ascii_whitespace();
    let Some(method) = parts.next() else {
        return write_empty_http(&mut stream, StatusCode::BAD_REQUEST, None);
    };
    let Some(target) = parts.next() else {
        return write_empty_http(&mut stream, StatusCode::BAD_REQUEST, None);
    };
    if method != "GET" && method != "HEAD" {
        return write_empty_http(&mut stream, StatusCode::METHOD_NOT_ALLOWED, None);
    }
    let token = target
        .split('?')
        .next()
        .unwrap_or_default()
        .trim_matches('/');
    if token.len() != 32 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return write_empty_http(&mut stream, StatusCode::NOT_FOUND, None);
    }
    let Some(grant) = registry
        .grants
        .read()
        .ok()
        .and_then(|grants| grants.get(token).cloned())
    else {
        return write_empty_http(&mut stream, StatusCode::NOT_FOUND, None);
    };
    serve_http_file(&mut stream, &grant, method == "HEAD", range.as_deref())
}

fn serve_http_file(
    stream: &mut TcpStream,
    grant: &MediaGrant,
    head_only: bool,
    requested: Option<&str>,
) -> std::io::Result<()> {
    let Ok(metadata) = std::fs::metadata(&grant.path) else {
        return write_empty_http(stream, StatusCode::NOT_FOUND, None);
    };
    let total = metadata.len();
    if total == 0 {
        return write_empty_http(stream, StatusCode::NOT_FOUND, None);
    }
    let Some((start, end)) = byte_range(requested, total) else {
        return write_empty_http(
            stream,
            StatusCode::RANGE_NOT_SATISFIABLE,
            Some(("Content-Range", format!("bytes */{total}"))),
        );
    };
    let length = end - start + 1;
    let status = if requested.is_some() {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    write!(
        stream,
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nAccept-Ranges: bytes\r\nContent-Length: {}\r\nCache-Control: no-store, private\r\nAccess-Control-Allow-Origin: *\r\nCross-Origin-Resource-Policy: cross-origin\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n",
        status.as_u16(),
        status.canonical_reason().unwrap_or("Response"),
        grant.content_type,
        length,
    )?;
    if status == StatusCode::PARTIAL_CONTENT {
        write!(stream, "Content-Range: bytes {start}-{end}/{total}\r\n")?;
    }
    write!(stream, "\r\n")?;
    if head_only {
        return stream.flush();
    }

    let mut file = std::fs::File::open(&grant.path)?;
    file.seek(SeekFrom::Start(start))?;
    std::io::copy(&mut file.take(length), stream)?;
    stream.flush()
}

fn write_empty_http(
    stream: &mut TcpStream,
    status: StatusCode,
    extra_header: Option<(&str, String)>,
) -> std::io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {} {}\r\nContent-Length: 0\r\nCache-Control: no-store\r\nConnection: close\r\n",
        status.as_u16(),
        status.canonical_reason().unwrap_or("Response"),
    )?;
    if let Some((name, value)) = extra_header {
        write!(stream, "{name}: {value}\r\n")?;
    }
    write!(stream, "\r\n")?;
    stream.flush()
}

#[cfg(test)]
fn serve_file(grant: &MediaGrant, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return empty_response(StatusCode::METHOD_NOT_ALLOWED);
    }
    let Ok(metadata) = std::fs::metadata(&grant.path) else {
        return empty_response(StatusCode::NOT_FOUND);
    };
    let total = metadata.len();
    if total == 0 {
        return empty_response(StatusCode::NOT_FOUND);
    }
    let requested = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok());
    let Some((start, end)) = byte_range(requested, total) else {
        return Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{total}"))
            .body(Vec::new())
            .expect("valid range response");
    };
    let length = end - start + 1;
    // A 206 response is only valid in reply to a Range request. Returning a
    // capped unsolicited 206 made WebView2 reject otherwise valid MP4 data.
    let status = if requested.is_some() {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, grant.content_type)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, length.to_string())
        .header(header::CACHE_CONTROL, "no-store, private")
        .header("Access-Control-Allow-Origin", "*")
        .header("X-Content-Type-Options", "nosniff");
    if status == StatusCode::PARTIAL_CONTENT {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{total}"),
        );
    }
    if request.method() == Method::HEAD {
        return builder.body(Vec::new()).expect("valid head response");
    }
    let Ok(mut file) = std::fs::File::open(&grant.path) else {
        return empty_response(StatusCode::NOT_FOUND);
    };
    if file.seek(SeekFrom::Start(start)).is_err() {
        return empty_response(StatusCode::INTERNAL_SERVER_ERROR);
    }
    let Ok(buffer_len) = usize::try_from(length) else {
        return empty_response(StatusCode::INTERNAL_SERVER_ERROR);
    };
    let mut body = vec![0_u8; buffer_len];
    if file.read_exact(&mut body).is_err() {
        return empty_response(StatusCode::INTERNAL_SERVER_ERROR);
    }
    builder.body(body).expect("valid media response")
}

fn byte_range(header: Option<&str>, total: u64) -> Option<(u64, u64)> {
    let Some(header) = header else {
        return Some((0, total - 1));
    };
    let value = header.strip_prefix("bytes=")?;
    if value.contains(',') {
        return None;
    }
    let (start, end) = value.split_once('-')?;
    if start.is_empty() {
        let suffix = end.parse::<u64>().ok()?.min(total);
        if suffix == 0 {
            return None;
        }
        return Some((total - suffix, total - 1));
    }
    let start = start.parse::<u64>().ok()?;
    if start >= total {
        return None;
    }
    let requested_end = if end.is_empty() {
        total - 1
    } else {
        end.parse::<u64>().ok()?.min(total - 1)
    };
    if requested_end < start {
        return None;
    }
    Some((start, requested_end))
}

fn media_type(path: &Path) -> &'static str {
    if let Ok(mut file) = std::fs::File::open(path) {
        let mut header = [0_u8; 12];
        if file.read_exact(&mut header).is_ok() {
            if &header[4..8] == b"ftyp" {
                return "video/mp4";
            }
            if header[..4] == [0x1a, 0x45, 0xdf, 0xa3] {
                return "video/x-matroska";
            }
            if &header[..4] == b"OggS" {
                return "video/ogg";
            }
        }
    }
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "mp4" => "video/mp4",
        "m4v" => "video/x-m4v",
        "mkv" => "video/x-matroska",
        "webm" => "video/webm",
        "ogv" | "ogg" => "video/ogg",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        "mpg" | "mpeg" => "video/mpeg",
        "ts" | "m2ts" => "video/mp2t",
        "wmv" => "video/x-ms-wmv",
        "mp3" => "audio/mpeg",
        "m4a" | "aac" => "audio/mp4",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
fn empty_response(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Vec::new())
        .expect("valid empty response")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn ranges_are_validated_and_open_ranges_are_honored() {
        assert_eq!(byte_range(Some("bytes=10-19"), 100), Some((10, 19)));
        assert_eq!(byte_range(Some("bytes=95-"), 100), Some((95, 99)));
        assert_eq!(byte_range(Some("bytes=0-"), 100), Some((0, 99)));
        assert_eq!(byte_range(Some("bytes=-5"), 100), Some((95, 99)));
        assert_eq!(byte_range(Some("bytes=10-20,30-40"), 100), None);
        assert_eq!(byte_range(Some("bytes=100-"), 100), None);
    }

    #[test]
    fn non_range_requests_receive_the_complete_resource() {
        assert_eq!(
            byte_range(None, 8 * 1024 * 1024),
            Some((0, 8 * 1024 * 1024 - 1))
        );
    }

    #[test]
    fn non_range_response_is_complete_and_returns_ok() {
        let mut file = tempfile::Builder::new()
            .suffix(".mp4")
            .tempfile()
            .expect("temporary media");
        file.write_all(&[0, 0, 0, 24, b'f', b't', b'y', b'p', 0, 1, 2, 3])
            .expect("write media");
        let path = file.path().canonicalize().expect("canonical media");
        let registry = EmbeddedMediaRegistry::default();
        let (_token, url) = registry.grant(path).expect("media grant");
        let request = Request::builder()
            .method(Method::GET)
            .uri(url)
            .body(Vec::new())
            .expect("media request");
        let response = registry.respond(request);

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body().len(), 12);
        assert!(response.headers().get(header::CONTENT_RANGE).is_none());
    }

    #[test]
    fn urls_expose_only_an_opaque_token() {
        let token = "0123456789abcdef0123456789abcdef";
        let url = EmbeddedMediaRegistry::default().media_url(token);
        assert!(url.ends_with(token));
        assert!(!url.contains("Users"));
    }

    #[test]
    fn scanned_video_extensions_receive_media_types() {
        assert_eq!(media_type(Path::new("lesson.mkv")), "video/x-matroska");
        assert_eq!(media_type(Path::new("lesson.mp4")), "video/mp4");
        assert_eq!(media_type(Path::new("lesson.avi")), "video/x-msvideo");
    }

    #[test]
    fn content_signature_wins_over_a_misleading_extension() {
        let mut file = tempfile::Builder::new()
            .suffix(".mp4")
            .tempfile()
            .expect("temporary media");
        file.write_all(&[0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0])
            .expect("write Matroska signature");
        assert_eq!(media_type(file.path()), "video/x-matroska");
    }

    #[test]
    fn granted_media_is_range_served_without_exposing_its_path() {
        let mut file = tempfile::Builder::new()
            .suffix(".mkv")
            .tempfile()
            .expect("temporary media");
        file.write_all(&[0, 1, 2, 3, 4, 5, 6, 7])
            .expect("write media");
        let path = file.path().canonicalize().expect("canonical media");
        let registry = EmbeddedMediaRegistry::default();
        let (_token, url) = registry.grant(path.clone()).expect("media grant");
        assert!(!url.contains(path.to_string_lossy().as_ref()));

        let request = Request::builder()
            .method(Method::GET)
            .uri(url)
            .header(header::RANGE, "bytes=2-5")
            .body(Vec::new())
            .expect("media request");
        let response = registry.respond(request);

        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "video/x-matroska");
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 2-5/8");
        assert_eq!(response.body(), &[2, 3, 4, 5]);
    }
}
