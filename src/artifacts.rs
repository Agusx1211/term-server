use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::Serialize;
use uuid::Uuid;

use crate::files::{self, FileEntry};

const MAX_ARTIFACTS: usize = 250;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactEntry {
    pub id: String,
    pub session_id: Uuid,
    #[serde(flatten)]
    pub file: FileEntry,
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
        left.file
            .modified_at
            .cmp(&right.file.modified_at)
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
    let file = fs::read_dir(directory.path())
        .ok()?
        .filter_map(Result::ok)
        .find_map(|candidate| {
            if !candidate.file_type().ok()?.is_file() {
                return None;
            }
            files::metadata(candidate.path().to_str()?, None).ok()
        })?;
    Some(ArtifactEntry {
        id,
        session_id,
        file,
    })
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
}
