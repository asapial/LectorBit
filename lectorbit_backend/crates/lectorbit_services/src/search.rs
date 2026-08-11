//! Deterministic SQLite FTS5 search over labels, transcripts, and annotations.

use lectorbit_db::{AnalysisRepo, DbError};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SearchSource {
    Media,
    Transcript,
    Annotation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SearchHit {
    pub media_id: String,
    pub display_name: String,
    pub plan_item_id: Option<String>,
    pub source: SearchSource,
    pub start_ms: Option<u64>,
    pub end_ms: Option<u64>,
    pub snippet: String,
    pub score: u32,
}

#[derive(Debug, Error)]
pub enum SearchError {
    #[error("enter at least one searchable word")]
    EmptyQuery,
    #[error("database error: {0}")]
    Database(String),
}

impl From<DbError> for SearchError {
    fn from(error: DbError) -> Self {
        Self::Database(error.to_string())
    }
}

#[derive(Clone)]
pub struct SearchService {
    repo: AnalysisRepo,
}

impl SearchService {
    pub fn new(repo: AnalysisRepo) -> Self {
        Self { repo }
    }

    pub async fn search(&self, raw: &str, limit: u32) -> Result<Vec<SearchHit>, SearchError> {
        let query = build_fts_query(raw);
        if query.is_empty() {
            return Err(SearchError::EmptyQuery);
        }
        let rows = self.repo.search(&query, limit).await?;
        let total = rows.len().max(1) as u32;
        Ok(rows
            .into_iter()
            .enumerate()
            .map(|(index, row)| SearchHit {
                media_id: row.media_id,
                display_name: row.display_name,
                plan_item_id: row.plan_item_id,
                source: match row.source.as_str() {
                    "transcript" => SearchSource::Transcript,
                    "annotation" => SearchSource::Annotation,
                    _ => SearchSource::Media,
                },
                start_ms: row.start_ms,
                end_ms: row.end_ms,
                snippet: row.snippet,
                score: 100_u32.saturating_sub((index as u32 * 35) / total),
            })
            .collect())
    }
}

/// Treat every user token as literal prefix text, never as raw FTS syntax.
pub fn build_fts_query(raw: &str) -> String {
    raw.split_whitespace()
        .filter_map(|token| {
            let cleaned = token
                .chars()
                .filter(|character| !character.is_control() && *character != '"')
                .take(64)
                .collect::<String>();
            (!cleaned.is_empty()).then(|| format!("\"{}\"*", cleaned.replace('"', "\"\"")))
        })
        .take(12)
        .collect::<Vec<_>>()
        .join(" AND ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_builder_never_exposes_fts_operators() {
        assert_eq!(
            build_fts_query("queue OR NEAR(video)"),
            "\"queue\"* AND \"OR\"* AND \"NEAR(video)\"*"
        );
        assert_eq!(build_fts_query("  \"lesson\"  "), "\"lesson\"*");
        assert_eq!(build_fts_query("\0"), "");
    }
}
