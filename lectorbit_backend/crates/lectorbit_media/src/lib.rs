//! Crawling and media-tool adapters.
//!
//! This crate only accepts backend-resolved paths. Renderer input never reaches
//! these functions directly, symlinks are not followed, and traversal stays
//! within the authorized root selected by the native picker.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub mod ffprobe;
pub use ffprobe::{
    parse_probe_json, probe_arguments, Ffprobe, ProbeError, ProbeMetadata, ProbeStream,
    EXPECTED_FFPROBE_VERSION,
};

const MAX_SCAN_ENTRIES: u64 = 1_000_000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MediaKind {
    Video,
    Audio,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MediaCandidate {
    pub absolute_path: PathBuf,
    pub kind: MediaKind,
    pub size_bytes: u64,
    pub modified_unix_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScanIssue {
    pub path: PathBuf,
    pub message: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct CrawlResult {
    pub candidates: Vec<MediaCandidate>,
    pub issues: Vec<ScanIssue>,
    pub visited_entries: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CrawlProgress {
    pub visited_entries: u64,
    pub media_candidates: u64,
}

#[derive(Debug, Error)]
pub enum CrawlError {
    #[error("scan root does not exist or is not a directory")]
    InvalidRoot,
    #[error("scan stopped after {0} entries")]
    EntryLimit(u64),
}

pub fn crawl_library(
    root: &Path,
    mut on_progress: impl FnMut(CrawlProgress),
) -> Result<CrawlResult, CrawlError> {
    if !root.is_absolute() || !root.is_dir() {
        return Err(CrawlError::InvalidRoot);
    }

    let mut result = CrawlResult::default();
    let mut directories = vec![root.to_path_buf()];
    let mut visited_directories = HashSet::new();

    while let Some(directory) = directories.pop() {
        if !visited_directories.insert(directory.clone()) {
            continue;
        }

        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) => {
                result.issues.push(ScanIssue {
                    path: directory,
                    message: error.to_string(),
                });
                continue;
            }
        };

        let mut entries = entries.filter_map(Result::ok).collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.file_name());

        for entry in entries {
            result.visited_entries += 1;
            if result.visited_entries > MAX_SCAN_ENTRIES {
                return Err(CrawlError::EntryLimit(MAX_SCAN_ENTRIES));
            }

            let path = entry.path();
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(error) => {
                    result.issues.push(ScanIssue {
                        path,
                        message: error.to_string(),
                    });
                    continue;
                }
            };

            // Following symlinks would let a scan escape the authorized root.
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                directories.push(path);
                continue;
            }
            if !file_type.is_file() {
                continue;
            }

            let Some(kind) = media_kind(&path) else {
                continue;
            };
            match entry.metadata() {
                Ok(metadata) => {
                    let modified_unix_ms = metadata
                        .modified()
                        .ok()
                        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                        .and_then(|value| i64::try_from(value.as_millis()).ok())
                        .unwrap_or_default();
                    result.candidates.push(MediaCandidate {
                        absolute_path: path,
                        kind,
                        size_bytes: metadata.len(),
                        modified_unix_ms,
                    });
                }
                Err(error) => result.issues.push(ScanIssue {
                    path,
                    message: error.to_string(),
                }),
            }

            if result.visited_entries % 64 == 0 {
                on_progress(CrawlProgress {
                    visited_entries: result.visited_entries,
                    media_candidates: result.candidates.len() as u64,
                });
            }
        }
    }

    on_progress(CrawlProgress {
        visited_entries: result.visited_entries,
        media_candidates: result.candidates.len() as u64,
    });
    Ok(result)
}

fn media_kind(path: &Path) -> Option<MediaKind> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "mp4" | "mkv" | "webm" | "mov" | "avi" | "m4v" | "mpg" | "mpeg" | "ts" | "m2ts" | "wmv"
        | "flv" => Some(MediaKind::Video),
        "mp3" | "m4a" | "aac" | "flac" | "wav" | "ogg" | "opus" => Some(MediaKind::Audio),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans_supported_media_recursively_and_skips_other_files() {
        let temp = tempfile::tempdir().expect("tempdir");
        let nested = temp.path().join("course");
        fs::create_dir_all(&nested).expect("nested");
        fs::write(temp.path().join("intro.mp4"), b"video").expect("video");
        fs::write(nested.join("lesson.MKV"), b"video").expect("nested video");
        fs::write(nested.join("notes.txt"), b"notes").expect("notes");

        let mut progress = Vec::new();
        let result = crawl_library(temp.path(), |event| progress.push(event)).expect("scan");

        assert_eq!(result.candidates.len(), 2);
        assert_eq!(result.issues.len(), 0);
        assert!(progress
            .last()
            .is_some_and(|event| event.media_candidates == 2));
        assert!(result
            .candidates
            .iter()
            .all(|candidate| candidate.kind == MediaKind::Video));
    }

    #[test]
    fn rejects_relative_or_missing_roots() {
        let error = crawl_library(Path::new("relative"), |_| {}).expect_err("invalid root");
        assert!(matches!(error, CrawlError::InvalidRoot));
    }

    #[test]
    fn extension_classification_is_case_insensitive() {
        assert_eq!(media_kind(Path::new("lecture.MP4")), Some(MediaKind::Video));
        assert_eq!(media_kind(Path::new("voice.FLAC")), Some(MediaKind::Audio));
        assert_eq!(media_kind(Path::new("slides.pdf")), None);
    }
}
