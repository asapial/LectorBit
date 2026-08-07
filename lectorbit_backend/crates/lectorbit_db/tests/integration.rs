//! Black-box tests for `lectorbit_db` — opens an in-memory DB through the
//! public API and asserts schema-level invariants.

use lectorbit_db::Db;

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
