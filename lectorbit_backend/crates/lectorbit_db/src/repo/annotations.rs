//! Canonical local persistence for timestamped learning-trail annotations.

use sqlx::{Row, SqlitePool};

use crate::{DbError, DbResult};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnnotationRow {
    pub id: String,
    pub media_id: String,
    pub at_ms: u64,
    pub kind: String,
    pub text: String,
    pub reviewed: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone)]
pub struct Repo {
    pool: SqlitePool,
}

impl Repo {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn media_duration_ms(&self, media_id: &str) -> DbResult<Option<Option<u64>>> {
        let row = sqlx::query(
            "SELECT media.duration_ms FROM media_files media \
             JOIN library_roots root ON root.id = media.root_id AND root.revoked_at IS NULL \
             WHERE media.id = ?",
        )
        .bind(media_id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(|row| {
            row.try_get::<Option<i64>, _>("duration_ms")
                .map(|value| value.map(nonnegative_u64))
                .map_err(DbError::from)
        })
        .transpose()
    }

    pub async fn insert(&self, annotation: &AnnotationRow) -> DbResult<()> {
        sqlx::query(
            "INSERT INTO annotations \
             (id, media_id, at_ms, text, created_at, updated_at, kind, reviewed) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&annotation.id)
        .bind(&annotation.media_id)
        .bind(to_i64(annotation.at_ms))
        .bind(&annotation.text)
        .bind(&annotation.created_at)
        .bind(&annotation.updated_at)
        .bind(&annotation.kind)
        .bind(annotation.reviewed)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Insert while every learning-trail row remains reachable by the bounded
    /// list API. The count and insert share one SQLite write statement, so
    /// concurrent IPC calls cannot exceed the cap.
    pub async fn insert_learning_trail_bounded(
        &self,
        annotation: &AnnotationRow,
        max_items: u32,
    ) -> DbResult<bool> {
        let result = sqlx::query(
            "INSERT INTO annotations \
             (id, media_id, at_ms, text, created_at, updated_at, kind, reviewed) \
             SELECT ?, ?, ?, ?, ?, ?, ?, ? \
             WHERE (SELECT COUNT(*) FROM annotations \
                    WHERE media_id = ? AND kind IN ('question', 'takeaway')) < ?",
        )
        .bind(&annotation.id)
        .bind(&annotation.media_id)
        .bind(to_i64(annotation.at_ms))
        .bind(&annotation.text)
        .bind(&annotation.created_at)
        .bind(&annotation.updated_at)
        .bind(&annotation.kind)
        .bind(annotation.reviewed)
        .bind(&annotation.media_id)
        .bind(i64::from(max_items))
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    pub async fn list_learning_trail(
        &self,
        media_id: &str,
        limit: u32,
    ) -> DbResult<Vec<AnnotationRow>> {
        let rows = sqlx::query(
            "SELECT id, media_id, at_ms, kind, text, reviewed, created_at, updated_at \
             FROM annotations \
             WHERE media_id = ? AND kind IN ('question', 'takeaway') \
             ORDER BY created_at DESC, id DESC LIMIT ?",
        )
        .bind(media_id)
        .bind(i64::from(limit.clamp(1, 100)))
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(annotation_from_row).collect()
    }

    pub async fn set_reviewed(
        &self,
        media_id: &str,
        annotation_id: &str,
        reviewed: bool,
        updated_at: &str,
    ) -> DbResult<Option<AnnotationRow>> {
        let row = sqlx::query(
            "UPDATE annotations SET reviewed = ?, updated_at = ? \
             WHERE id = ? AND media_id = ? AND kind IN ('question', 'takeaway') \
             RETURNING id, media_id, at_ms, kind, text, reviewed, created_at, updated_at",
        )
        .bind(reviewed)
        .bind(updated_at)
        .bind(annotation_id)
        .bind(media_id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(annotation_from_row).transpose()
    }

    pub async fn remove(&self, media_id: &str, annotation_id: &str) -> DbResult<bool> {
        let result = sqlx::query(
            "DELETE FROM annotations \
             WHERE id = ? AND media_id = ? AND kind IN ('question', 'takeaway')",
        )
        .bind(annotation_id)
        .bind(media_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }
}

fn annotation_from_row(row: sqlx::sqlite::SqliteRow) -> DbResult<AnnotationRow> {
    Ok(AnnotationRow {
        id: row.try_get("id")?,
        media_id: row.try_get("media_id")?,
        at_ms: nonnegative_u64(row.try_get("at_ms")?),
        kind: row.try_get("kind")?,
        text: row.try_get("text")?,
        reviewed: row.try_get("reviewed")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn nonnegative_u64(value: i64) -> u64 {
    value.max(0) as u64
}

fn to_i64(value: u64) -> i64 {
    value.min(i64::MAX as u64) as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn seeded_repo() -> Repo {
        let db = crate::Db::open_in_memory().await.expect("database");
        sqlx::query(
            "INSERT INTO library_roots \
             (id, display_name, canonical_path, registered_at, revoked_at) \
             VALUES ('root', 'Lectures', 'C:/lectures', '2026-08-23T00:00:00Z', NULL)",
        )
        .execute(db.pool())
        .await
        .expect("root");
        sqlx::query(
            "INSERT INTO media_files \
             (id, root_id, folder_id, path, size_bytes, mtime, discovered_at, display_name, duration_ms) \
             VALUES ('media', 'root', NULL, 'C:/lectures/demo.mp4', 1, \
                     '2026-08-23T00:00:00Z', '2026-08-23T00:00:00Z', 'demo.mp4', 600000)",
        )
        .execute(db.pool())
        .await
        .expect("media");
        Repo::new(db.pool().clone())
    }

    #[tokio::test]
    async fn learning_trail_crud_keeps_fts_in_sync() {
        let repo = seeded_repo().await;
        let annotation = AnnotationRow {
            id: "annotation-1".into(),
            media_id: "media".into(),
            at_ms: 245_000,
            kind: "question".into(),
            text: "Why does breadth-first search find the shortest path?".into(),
            reviewed: false,
            created_at: "2026-08-23T00:00:00Z".into(),
            updated_at: "2026-08-23T00:00:00Z".into(),
        };

        repo.insert(&annotation).await.expect("insert annotation");
        let listed = repo
            .list_learning_trail("media", 100)
            .await
            .expect("list annotations");
        assert_eq!(listed, vec![annotation.clone()]);
        let indexed: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM annotation_fts WHERE annotation_fts MATCH '\"breadth\"*'",
        )
        .fetch_one(&repo.pool)
        .await
        .expect("search annotation");
        assert_eq!(indexed, 1);

        let reviewed = repo
            .set_reviewed("media", "annotation-1", true, "2026-08-23T00:01:00Z")
            .await
            .expect("review annotation")
            .expect("annotation exists");
        assert!(reviewed.reviewed);

        assert!(repo
            .remove("media", "annotation-1")
            .await
            .expect("remove annotation"));
        let indexed: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM annotation_fts WHERE annotation_fts MATCH '\"breadth\"*'",
        )
        .fetch_one(&repo.pool)
        .await
        .expect("search removed annotation");
        assert_eq!(indexed, 0);

        sqlx::query(
            "UPDATE library_roots SET revoked_at = '2026-08-23T01:00:00Z' WHERE id = 'root'",
        )
        .execute(&repo.pool)
        .await
        .expect("revoke root");
        assert_eq!(
            repo.media_duration_ms("media")
                .await
                .expect("authorized media lookup"),
            None
        );
    }
}
