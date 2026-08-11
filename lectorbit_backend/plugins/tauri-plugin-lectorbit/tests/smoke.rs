use std::sync::Arc;

use tauri_plugin_lectorbit::{
    app_get_version, BoxFuture, DiagnosticsProvider, LibraryErrorCode, LibraryErrorKind,
    LibraryOps, LibraryRootDto, ScanEventSink, ScanJobDto,
};

#[test]
fn app_version_is_available_without_a_runtime() {
    assert!(!app_get_version().version.is_empty());
}

struct FakeDiagnostics;

impl DiagnosticsProvider for FakeDiagnostics {
    fn snapshot(&self) -> serde_json::Value {
        serde_json::json!({ "redacted": true })
    }
}

#[test]
fn diagnostics_boundary_is_serializable() {
    let provider: Arc<dyn DiagnosticsProvider> = Arc::new(FakeDiagnostics);
    assert_eq!(provider.snapshot()["redacted"], true);
}

struct FakeLibrary;

impl LibraryOps for FakeLibrary {
    fn list_roots(&self) -> BoxFuture<'_, Result<Vec<LibraryRootDto>, LibraryErrorCode>> {
        Box::pin(async {
            Ok(vec![LibraryRootDto {
                id: "root".into(),
                display_name: "Videos".into(),
                path_redacted: "[REDACTED]/Videos".into(),
                registered_at: "2026-08-08T00:00:00Z".into(),
                revoked_at: None,
                is_active: true,
            }])
        })
    }

    fn register_selected_root(
        &self,
        _selected_path: String,
    ) -> BoxFuture<'_, Result<LibraryRootDto, LibraryErrorCode>> {
        Box::pin(async {
            Err(LibraryErrorCode::new(
                LibraryErrorKind::NotADirectory,
                "invalid folder",
            ))
        })
    }

    fn revoke_root(&self, _id: String) -> BoxFuture<'_, Result<LibraryRootDto, LibraryErrorCode>> {
        Box::pin(async {
            Err(LibraryErrorCode::new(
                LibraryErrorKind::NotFound,
                "unknown root",
            ))
        })
    }

    fn enqueue_scan(
        &self,
        root_id: String,
        _sink: ScanEventSink,
    ) -> BoxFuture<'_, Result<ScanJobDto, LibraryErrorCode>> {
        Box::pin(async move {
            Ok(ScanJobDto {
                id: "job".into(),
                root_id,
                status: "queued".into(),
                attempt: 0,
                last_error: None,
                created_at: "2026-08-08T00:00:00Z".into(),
                updated_at: "2026-08-08T00:00:00Z".into(),
            })
        })
    }

    fn list_scan_jobs(
        &self,
        _root_id: Option<String>,
    ) -> BoxFuture<'_, Result<Vec<ScanJobDto>, LibraryErrorCode>> {
        Box::pin(async { Ok(Vec::new()) })
    }
}

#[tokio::test(flavor = "current_thread")]
async fn library_boundary_exposes_only_safe_root_metadata() {
    let library: Arc<dyn LibraryOps> = Arc::new(FakeLibrary);
    let root = library.list_roots().await.expect("roots").remove(0);
    let serialized = serde_json::to_value(root).expect("serialize");
    assert_eq!(serialized["path_redacted"], "[REDACTED]/Videos");
    assert!(serialized.get("canonical_path").is_none());
}

#[tokio::test(flavor = "current_thread")]
async fn scan_job_is_keyed_by_authorized_root_id() {
    let library: Arc<dyn LibraryOps> = Arc::new(FakeLibrary);
    let job = library
        .enqueue_scan("root".into(), Arc::new(|_| {}))
        .await
        .expect("enqueue");
    assert_eq!(job.root_id, "root");
    assert_eq!(job.status, "queued");
}
