use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::files::{self, FileEntry};

const MAX_ARTIFACTS: usize = 250;
const MAX_METADATA_BYTES: u64 = 4 * 1024;
const MAX_JAVASCRIPT_DATE_MILLIS: u64 = 8_640_000_000_000_000;
const METADATA_FILE: &str = ".artifact.json";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactEntry {
    pub id: String,
    pub session_id: Uuid,
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub producer: Option<String>,
    #[serde(flatten)]
    pub file: FileEntry,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactMetadata {
    created_at: Option<u64>,
    producer: Option<String>,
}

pub fn root_directory() -> PathBuf {
    std::env::temp_dir().join("artifacts")
}

pub fn list_for_sessions(session_ids: &[Uuid]) -> Vec<ArtifactEntry> {
    list_in(&root_directory(), session_ids)
}

fn list_in(root: &Path, session_ids: &[Uuid]) -> Vec<ArtifactEntry> {
    let mut artifacts = Vec::new();
    for session_id in session_ids {
        let Ok(entries) = fs::read_dir(root.join(session_id.to_string())) else {
            continue;
        };
        artifacts.extend(
            entries
                .filter_map(Result::ok)
                .filter_map(|directory| artifact_from_directory(*session_id, directory)),
        );
    }
    artifacts.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then_with(|| left.file.modified_at.cmp(&right.file.modified_at))
            .then_with(|| left.file.path.cmp(&right.file.path))
    });
    if artifacts.len() > MAX_ARTIFACTS {
        artifacts.drain(..artifacts.len() - MAX_ARTIFACTS);
    }
    artifacts
}

fn artifact_from_directory(session_id: Uuid, directory: fs::DirEntry) -> Option<ArtifactEntry> {
    if !directory.file_type().ok()?.is_dir() {
        return None;
    }
    let id = directory.file_name().to_str()?.to_owned();
    Uuid::parse_str(&id).ok()?;
    let directory_metadata = directory.metadata().ok()?;
    let fallback_created_at = directory_metadata
        .created()
        .or_else(|_| directory_metadata.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH)
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX);
    let metadata = artifact_metadata(&directory.path()).unwrap_or_default();
    let mut files = fs::read_dir(directory.path())
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|candidate| {
            if candidate.file_name().to_str()?.starts_with('.') {
                return None;
            }
            if !candidate.file_type().ok()?.is_file() {
                return None;
            }
            files::metadata(candidate.path().to_str()?, None).ok()
        });
    let file = files.next()?;
    if files.next().is_some() {
        return None;
    }
    Some(ArtifactEntry {
        id,
        session_id,
        created_at: metadata.created_at.unwrap_or(fallback_created_at),
        producer: metadata.producer,
        file,
    })
}

fn artifact_metadata(directory: &Path) -> Option<ArtifactMetadata> {
    let path = directory.join(METADATA_FILE);
    let metadata = fs::metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_METADATA_BYTES {
        return None;
    }
    let mut metadata = serde_json::from_slice::<ArtifactMetadata>(&fs::read(path).ok()?).ok()?;
    metadata.created_at = metadata
        .created_at
        .filter(|timestamp| *timestamp <= MAX_JAVASCRIPT_DATE_MILLIS);
    metadata.producer = metadata.producer.filter(|producer| {
        !producer.is_empty()
            && producer.len() <= 64
            && producer
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    });
    Some(metadata)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_regular_artifacts_for_the_requested_sessions_only() {
        let root = tempfile::tempdir().unwrap();
        let included_session = Uuid::new_v4();
        let excluded_session = Uuid::new_v4();
        let artifact_id = Uuid::new_v4();
        let artifact_directory = root
            .path()
            .join(included_session.to_string())
            .join(artifact_id.to_string());
        fs::create_dir_all(&artifact_directory).unwrap();
        fs::write(artifact_directory.join("message.md"), "hello").unwrap();
        let excluded_directory = root
            .path()
            .join(excluded_session.to_string())
            .join(Uuid::new_v4().to_string());
        fs::create_dir_all(&excluded_directory).unwrap();
        fs::write(excluded_directory.join("private.md"), "not included").unwrap();

        let artifacts = list_in(root.path(), &[included_session]);

        assert_eq!(artifacts.len(), 1);
        assert_eq!(artifacts[0].session_id, included_session);
        assert_eq!(artifacts[0].id, artifact_id.to_string());
        assert_eq!(artifacts[0].file.name, "message.md");
        assert!(artifacts[0].created_at > 0);
        assert_eq!(artifacts[0].producer, None);
    }

    #[test]
    fn ignores_unstructured_files_and_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let session = Uuid::new_v4();
        let session_directory = root.path().join(session.to_string());
        fs::create_dir_all(&session_directory).unwrap();
        fs::write(session_directory.join("loose.md"), "ignored").unwrap();
        let invalid_directory = session_directory.join("not-an-artifact-id");
        fs::create_dir(&invalid_directory).unwrap();
        fs::write(invalid_directory.join("message.md"), "ignored").unwrap();

        #[cfg(unix)]
        {
            let artifact_directory = session_directory.join(Uuid::new_v4().to_string());
            fs::create_dir(&artifact_directory).unwrap();
            std::os::unix::fs::symlink(
                session_directory.join("loose.md"),
                artifact_directory.join("linked.md"),
            )
            .unwrap();
        }

        assert!(list_in(root.path(), &[session]).is_empty());
    }

    #[test]
    fn exposes_only_complete_unambiguous_artifacts() {
        let root = tempfile::tempdir().unwrap();
        let session = Uuid::new_v4();
        let session_directory = root.path().join(session.to_string());
        fs::create_dir_all(&session_directory).unwrap();

        let staging_directory = session_directory.join(".artifact-in-progress");
        fs::create_dir(&staging_directory).unwrap();
        fs::write(staging_directory.join("message.md"), "partial").unwrap();

        let ambiguous_directory = session_directory.join(Uuid::new_v4().to_string());
        fs::create_dir(&ambiguous_directory).unwrap();
        fs::write(ambiguous_directory.join("first.md"), "first").unwrap();
        fs::write(ambiguous_directory.join("second.md"), "second").unwrap();

        let complete_directory = session_directory.join(Uuid::new_v4().to_string());
        fs::create_dir(&complete_directory).unwrap();
        fs::write(complete_directory.join(".artifact-temporary"), "ignored").unwrap();
        fs::write(
            complete_directory.join(METADATA_FILE),
            r#"{"createdAt":1234,"producer":"codex"}"#,
        )
        .unwrap();
        fs::write(complete_directory.join("ready.md"), "ready").unwrap();

        let artifacts = list_in(root.path(), &[session]);
        assert_eq!(artifacts.len(), 1);
        assert_eq!(artifacts[0].file.name, "ready.md");
        assert_eq!(artifacts[0].created_at, 1234);
        assert_eq!(artifacts[0].producer.as_deref(), Some("codex"));
    }
}
