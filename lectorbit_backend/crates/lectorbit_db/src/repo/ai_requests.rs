//! Append-only cloud consent and safe AI request provenance.

use chrono::Utc;
use serde::Serialize;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{DbError, DbResult};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudConsentSummary<'a> {
    pub request_id: &'a str,
    pub provider: &'a str,
    pub data_categories: &'a [&'a str],
    pub approximate_bytes: u64,
    pub retention_policy: &'a str,
}

#[derive(Debug, Clone)]
pub struct AiRequestProvenance<'a> {
    pub request_id: &'a str,
    pub provider: &'a str,
    pub capability: &'a str,
    pub prompt_id: &'a str,
    pub prompt_version: &'a str,
    pub requested_model: &'a str,
    pub resolved_model: Option<&'a str>,
    pub request_bytes: u64,
    pub response_bytes: Option<u64>,
    pub duration_ms: u64,
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub result: &'a str,
    pub error_kind: Option<&'a str>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiRequestEventRow {
    pub id: String,
    pub provider: String,
    pub capability: String,
    pub prompt_id: String,
    pub prompt_version: String,
    pub requested_model: String,
    pub resolved_model: Option<String>,
    pub request_bytes: u64,
    pub response_bytes: Option<u64>,
    pub duration_ms: u64,
    pub total_tokens: Option<u64>,
    pub result: String,
    pub error_kind: Option<String>,
    pub consent_scope: String,
    pub created_at: String,
}

#[derive(Clone)]
pub struct Repo {
    pool: SqlitePool,
}

impl Repo {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// Record the user's per-request authorization before bytes leave the device.
    pub async fn record_cloud_consent(
        &self,
        scope: &str,
        summary: &CloudConsentSummary<'_>,
    ) -> DbResult<String> {
        let id = Uuid::new_v4().to_string();
        let payload =
            serde_json::to_string(summary).map_err(|error| DbError::Pool(error.to_string()))?;
        sqlx::query(
            "INSERT INTO consent_events (id, user_id, scope, granted, payload, created_at) \
             VALUES (?, 'local', ?, 1, ?, ?)",
        )
        .bind(&id)
        .bind(scope)
        .bind(payload)
        .bind(Utc::now().to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(id)
    }

    /// Record only bounded operational metadata; user content is not accepted.
    pub async fn record_provenance(
        &self,
        consent_event_id: &str,
        event: &AiRequestProvenance<'_>,
    ) -> DbResult<()> {
        sqlx::query(
            "INSERT INTO ai_request_events \
             (id, consent_event_id, request_id, provider, capability, prompt_id, prompt_version, \
              requested_model, resolved_model, request_bytes, response_bytes, duration_ms, \
              prompt_tokens, completion_tokens, total_tokens, result, error_kind, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(consent_event_id)
        .bind(event.request_id)
        .bind(event.provider)
        .bind(event.capability)
        .bind(event.prompt_id)
        .bind(event.prompt_version)
        .bind(event.requested_model)
        .bind(event.resolved_model)
        .bind(to_i64(event.request_bytes))
        .bind(event.response_bytes.map(to_i64))
        .bind(to_i64(event.duration_ms))
        .bind(event.prompt_tokens.map(to_i64))
        .bind(event.completion_tokens.map(to_i64))
        .bind(event.total_tokens.map(to_i64))
        .bind(event.result)
        .bind(event.error_kind)
        .bind(Utc::now().to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn list_provenance(&self, limit: u32) -> DbResult<Vec<AiRequestEventRow>> {
        use sqlx::Row;
        let rows = sqlx::query(
            "SELECT event.id, event.provider, event.capability, event.prompt_id, \
                    event.prompt_version, event.requested_model, event.resolved_model, \
                    event.request_bytes, event.response_bytes, event.duration_ms, \
                    event.total_tokens, event.result, event.error_kind, consent.scope AS consent_scope, \
                    event.created_at \
             FROM ai_request_events event \
             JOIN consent_events consent ON consent.id = event.consent_event_id \
             ORDER BY event.created_at DESC LIMIT ?",
        )
        .bind(i64::from(limit.clamp(1, 500)))
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(AiRequestEventRow {
                    id: row.try_get("id")?,
                    provider: row.try_get("provider")?,
                    capability: row.try_get("capability")?,
                    prompt_id: row.try_get("prompt_id")?,
                    prompt_version: row.try_get("prompt_version")?,
                    requested_model: row.try_get("requested_model")?,
                    resolved_model: row.try_get("resolved_model")?,
                    request_bytes: nonnegative_u64(row.try_get("request_bytes")?),
                    response_bytes: row
                        .try_get::<Option<i64>, _>("response_bytes")?
                        .map(nonnegative_u64),
                    duration_ms: nonnegative_u64(row.try_get("duration_ms")?),
                    total_tokens: row
                        .try_get::<Option<i64>, _>("total_tokens")?
                        .map(nonnegative_u64),
                    result: row.try_get("result")?,
                    error_kind: row.try_get("error_kind")?,
                    consent_scope: row.try_get("consent_scope")?,
                    created_at: row.try_get("created_at")?,
                })
            })
            .collect()
    }
}

fn to_i64(value: u64) -> i64 {
    value.min(i64::MAX as u64) as i64
}

fn nonnegative_u64(value: i64) -> u64 {
    u64::try_from(value.max(0)).unwrap_or_default()
}
