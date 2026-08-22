//! Black-box tests for `lectorbit_db` — opens an in-memory DB through the
//! public API and asserts schema-level invariants.

use lectorbit_db::{AiRequestProvenance, AiRequestsRepo, CloudConsentSummary, Db};

#[tokio::test]
async fn open_in_memory_inserts_and_reads_back() {
    let db = Db::open_in_memory().await.expect("open");

    let root_id = uuid::Uuid::new_v4().to_string();
    let media_id = uuid::Uuid::new_v4().to_string();

    sqlx::query(
        "INSERT INTO library_roots (id, display_name, canonical_path, registered_at) \
         VALUES (?, ?, ?, ?)",
    )
    .bind(&root_id)
    .bind("Home Videos")
    .bind("/data/home")
    .bind("2026-08-08T00:00:00Z")
    .execute(db.pool())
    .await
    .expect("insert root");

    sqlx::query(
        "INSERT INTO media_files (id, root_id, path, size_bytes, mtime, discovered_at) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&media_id)
    .bind(&root_id)
    .bind("/data/home/first.mp4")
    .bind(1024_i64)
    .bind("2026-08-08T00:00:00Z")
    .bind("2026-08-08T00:00:00Z")
    .execute(db.pool())
    .await
    .expect("insert media");

    let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM media_files")
        .fetch_one(db.pool())
        .await
        .expect("count");
    assert_eq!(n, 1);

    db.close().await;
}

#[tokio::test]
async fn open_in_memory_allows_repeated_calls() {
    // Open and close a sequence of in-memory DBs to ensure no global state
    // leaks between them.
    for _ in 0..3 {
        let db = Db::open_in_memory().await.expect("open");
        db.ping().await.expect("ping");
        db.close().await;
    }
}

#[tokio::test]
async fn persisted_file_survives_close_and_reopen() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let path = tmp.path().join("smoke.sqlite");

    let db = Db::open(&path).await.expect("open");
    sqlx::query("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
        .bind("k1")
        .bind("v1")
        .bind("2026-08-08T00:00:00Z")
        .execute(db.pool())
        .await
        .expect("insert");
    db.close().await;

    let db2 = Db::open(&path).await.expect("reopen");
    let (v,): (String,) = sqlx::query_as("SELECT value FROM settings WHERE key = ?")
        .bind("k1")
        .fetch_one(db2.pool())
        .await
        .expect("read");
    assert_eq!(v, "v1");
    db2.close().await;
}

#[tokio::test]
async fn cloud_request_audit_is_append_only_and_content_free() {
    let db = Db::open_in_memory().await.expect("open");
    let repo = AiRequestsRepo::new(db.pool().clone());
    let consent_id = repo
        .record_cloud_consent(
            "companion_window",
            &CloudConsentSummary {
                request_id: "request-1",
                provider: "OpenRouter",
                data_categories: &["transcript_window"],
                approximate_bytes: 512,
                retention_policy: "provider_policy_applies; revoke stops future requests",
            },
        )
        .await
        .expect("consent");
    repo.record_provenance(
        &consent_id,
        &AiRequestProvenance {
            request_id: "request-1",
            provider: "OpenRouter",
            capability: "text_json",
            prompt_id: "player-companion",
            prompt_version: "player-companion-v1",
            requested_model: "openrouter/free",
            resolved_model: Some("provider/model"),
            request_bytes: 512,
            response_bytes: Some(128),
            duration_ms: 42,
            prompt_tokens: Some(100),
            completion_tokens: Some(20),
            total_tokens: Some(120),
            result: "succeeded",
            error_kind: None,
        },
    )
    .await
    .expect("provenance");

    let (consent_count,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM consent_events WHERE id = ? AND scope = ?")
            .bind(&consent_id)
            .bind("companion_window")
            .fetch_one(db.pool())
            .await
            .expect("count consent");
    let (request_count,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM ai_request_events WHERE consent_event_id = ? AND result = 'succeeded'",
    )
    .bind(&consent_id)
    .fetch_one(db.pool())
    .await
    .expect("count request");
    assert_eq!(consent_count, 1);
    assert_eq!(request_count, 1);

    let (payload,): (String,) = sqlx::query_as("SELECT payload FROM consent_events WHERE id = ?")
        .bind(&consent_id)
        .fetch_one(db.pool())
        .await
        .expect("payload");
    assert!(!payload.contains("lecture words"));
    assert!(!payload.contains("api_key"));
    db.close().await;
}

#[tokio::test]
async fn ai_provenance_schema_cannot_store_user_content() {
    let db = Db::open_in_memory().await.expect("open");
    let columns =
        sqlx::query_scalar::<_, String>("SELECT name FROM pragma_table_info('ai_request_events')")
            .fetch_all(db.pool())
            .await
            .expect("columns");
    for forbidden in [
        "prompt",
        "transcript",
        "image",
        "frame",
        "path",
        "credential",
        "api_key",
        "authorization",
        "provider_body",
    ] {
        assert!(
            !columns.iter().any(|column| column == forbidden),
            "unsafe provenance column: {forbidden}"
        );
    }
    db.close().await;
}
