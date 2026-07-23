use std::{
    env, fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use ignore::WalkBuilder;
use percent_encoding::percent_decode_str;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;
use thiserror::Error;

pub const MAX_EDIT_BYTES: u64 = 2 * 1024 * 1024;
pub const MAX_IMAGE_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_REQUEST_BYTES: usize = 6 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES: usize = 1_000;
const DEFAULT_SEARCH_RESULTS: usize = 100;
const MAX_SEARCH_RESULTS: usize = 250;

#[derive(Debug, Error)]
pub enum FileError {
    #[error("file path is empty")]
    EmptyPath,
    #[error("remote file URIs are not supported")]
    RemoteFileUri,
    #[error("file path is not valid UTF-8")]
    InvalidEncoding,
    #[error("file or directory was not found")]
    NotFound,
    #[error("path is not a regular file")]
    NotAFile,
    #[error("path is not a directory")]
    NotADirectory,
    #[error("file exceeds the supported size limit")]
    TooLarge,
    #[error("file is binary or is not valid UTF-8")]
    NotText,
    #[error("file is not a supported image")]
    NotImage,
    #[error("file changed on disk; reload it before saving")]
    Conflict,
    #[error("filesystem operation failed")]
    Io(#[source] std::io::Error),
}

impl From<std::io::Error> for FileError {
    fn from(error: std::io::Error) -> Self {
        match error.kind() {
            std::io::ErrorKind::NotFound => Self::NotFound,
            _ => Self::Io(error),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub name: String,
    pub kind: &'static str,
    pub size: u64,
    pub modified_at: u64,
    pub mime: String,
    pub image: bool,
    pub editable: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryListing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<FileEntry>,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchResults {
    pub root: String,
    pub entries: Vec<FileEntry>,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDocument {
    pub path: String,
    pub name: String,
    pub mime: String,
    pub modified_at: u64,
    pub version: String,
    pub content: String,
}

pub struct ImageFile {
    pub bytes: Vec<u8>,
    pub mime: String,
}

fn home_directory() -> Result<PathBuf, FileError> {
    env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or(FileError::NotFound)
}

fn decode_input_path(raw: &str) -> Result<PathBuf, FileError> {
    let raw = raw.trim().trim_matches(['\'', '"']);
    if raw.is_empty() {
        return Err(FileError::EmptyPath);
    }
    let decoded = if let Some(uri) = raw.strip_prefix("file://") {
        let path = if let Some(path) = uri.strip_prefix("localhost/") {
            format!("/{path}")
        } else if uri.starts_with('/') {
            uri.to_owned()
        } else {
            return Err(FileError::RemoteFileUri);
        };
        percent_decode_str(&path)
            .decode_utf8()
            .map_err(|_| FileError::InvalidEncoding)?
            .into_owned()
    } else {
        raw.to_owned()
    };
    if decoded == "~" {
        return home_directory();
    }
    if let Some(relative) = decoded.strip_prefix("~/") {
        return Ok(home_directory()?.join(relative));
    }
    Ok(PathBuf::from(decoded))
}

pub fn resolve_existing(raw: &str, cwd: Option<&str>) -> Result<PathBuf, FileError> {
    let path = decode_input_path(raw)?;
    let path = if path.is_absolute() {
        path
    } else {
        let base = cwd
            .map(decode_input_path)
            .transpose()?
            .unwrap_or(home_directory()?);
        base.join(path)
    };
    Ok(path.canonicalize()?)
}

fn modified_at(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .unwrap_or(SystemTime::UNIX_EPOCH)
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_else(|| path.to_str().unwrap_or("/"))
        .to_owned()
}

fn mime_for(path: &Path) -> String {
    mime_guess::from_path(path)
        .first_or_octet_stream()
        .essence_str()
        .to_owned()
}

fn supported_image(mime: &str) -> bool {
    matches!(
        mime,
        "image/png"
            | "image/jpeg"
            | "image/gif"
            | "image/webp"
            | "image/bmp"
            | "image/avif"
            | "image/svg+xml"
            | "image/x-icon"
            | "image/vnd.microsoft.icon"
    )
}

fn entry(path: &Path) -> Result<FileEntry, FileError> {
    let metadata = fs::metadata(path)?;
    let is_directory = metadata.is_dir();
    let mime = if is_directory {
        "inode/directory".to_owned()
    } else {
        mime_for(path)
    };
    let image = !is_directory && supported_image(&mime);
    Ok(FileEntry {
        path: path.to_string_lossy().into_owned(),
        name: display_name(path),
        kind: if is_directory { "directory" } else { "file" },
        size: metadata.len(),
        modified_at: modified_at(&metadata),
        mime,
        image,
        editable: metadata.is_file() && !image && metadata.len() <= MAX_EDIT_BYTES,
    })
}

pub fn metadata(raw: &str, cwd: Option<&str>) -> Result<FileEntry, FileError> {
    entry(&resolve_existing(raw, cwd)?)
}

pub fn list_directory(raw: &str, cwd: Option<&str>) -> Result<DirectoryListing, FileError> {
    let directory = resolve_existing(raw, cwd)?;
    if !directory.is_dir() {
        return Err(FileError::NotADirectory);
    }
    let mut entries = fs::read_dir(&directory)?
        .filter_map(Result::ok)
        .filter_map(|item| entry(&item.path()).ok())
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        left.kind
            .cmp(right.kind)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    let truncated = entries.len() > MAX_DIRECTORY_ENTRIES;
    entries.truncate(MAX_DIRECTORY_ENTRIES);
    Ok(DirectoryListing {
        path: directory.to_string_lossy().into_owned(),
        parent: directory
            .parent()
            .map(|path| path.to_string_lossy().into_owned()),
        entries,
        truncated,
    })
}

fn skipped_directory(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| matches!(name, ".git" | "node_modules" | "target" | ".cache"))
}

pub fn search(
    raw_root: &str,
    cwd: Option<&str>,
    query: &str,
    requested_limit: Option<usize>,
) -> Result<FileSearchResults, FileError> {
    let root = resolve_existing(raw_root, cwd)?;
    if !root.is_dir() {
        return Err(FileError::NotADirectory);
    }
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Err(FileError::EmptyPath);
    }
    let limit = requested_limit
        .unwrap_or(DEFAULT_SEARCH_RESULTS)
        .clamp(1, MAX_SEARCH_RESULTS);
    let mut matches = Vec::new();
    let mut truncated = false;
    let walker = WalkBuilder::new(&root)
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .filter_entry(|candidate| candidate.depth() == 0 || !skipped_directory(candidate.path()))
        .build();
    for candidate in walker.filter_map(Result::ok).skip(1) {
        let name = candidate.file_name().to_string_lossy();
        if !name.to_lowercase().contains(&needle) {
            continue;
        }
        if matches.len() == limit {
            truncated = true;
            break;
        }
        if let Ok(item) = entry(candidate.path()) {
            matches.push(item);
        }
    }
    matches.sort_by(|left, right| {
        let left_prefix = !left.name.to_lowercase().starts_with(&needle);
        let right_prefix = !right.name.to_lowercase().starts_with(&needle);
        left_prefix
            .cmp(&right_prefix)
            .then_with(|| left.path.len().cmp(&right.path.len()))
            .then_with(|| left.path.cmp(&right.path))
    });
    Ok(FileSearchResults {
        root: root.to_string_lossy().into_owned(),
        entries: matches,
        truncated,
    })
}

fn version(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn read_limited(path: &Path, limit: u64) -> Result<Vec<u8>, FileError> {
    let metadata = fs::metadata(path)?;
    if !metadata.is_file() {
        return Err(FileError::NotAFile);
    }
    if metadata.len() > limit {
        return Err(FileError::TooLarge);
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    fs::File::open(path)?
        .take(limit + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(FileError::TooLarge);
    }
    Ok(bytes)
}

pub fn read_document(raw: &str, cwd: Option<&str>) -> Result<FileDocument, FileError> {
    let path = resolve_existing(raw, cwd)?;
    let metadata = fs::metadata(&path)?;
    let bytes = read_limited(&path, MAX_EDIT_BYTES)?;
    if bytes.contains(&0) {
        return Err(FileError::NotText);
    }
    let content = String::from_utf8(bytes.clone()).map_err(|_| FileError::NotText)?;
    Ok(FileDocument {
        path: path.to_string_lossy().into_owned(),
        name: display_name(&path),
        mime: mime_for(&path),
        modified_at: modified_at(&metadata),
        version: version(&bytes),
        content,
    })
}

pub fn read_image(raw: &str, cwd: Option<&str>) -> Result<ImageFile, FileError> {
    let path = resolve_existing(raw, cwd)?;
    let mime = mime_for(&path);
    if !supported_image(&mime) {
        return Err(FileError::NotImage);
    }
    Ok(ImageFile {
        bytes: read_limited(&path, MAX_IMAGE_BYTES)?,
        mime,
    })
}

pub fn save_document(
    raw: &str,
    cwd: Option<&str>,
    content: String,
    expected_version: &str,
) -> Result<FileDocument, FileError> {
    if content.len() as u64 > MAX_EDIT_BYTES {
        return Err(FileError::TooLarge);
    }
    let path = resolve_existing(raw, cwd)?;
    let current = read_limited(&path, MAX_EDIT_BYTES)?;
    if version(&current) != expected_version {
        return Err(FileError::Conflict);
    }
    let metadata = fs::metadata(&path)?;
    let parent = path.parent().ok_or(FileError::NotFound)?;
    let mut temporary = NamedTempFile::new_in(parent)?;
    temporary
        .as_file()
        .set_permissions(metadata.permissions())?;
    temporary.write_all(content.as_bytes())?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(&path)
        .map_err(|error| FileError::Io(error.error))?;
    read_document(path.to_string_lossy().as_ref(), None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_percent_encoded_local_file_uri() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("space name.txt");
        fs::write(&path, "hello").unwrap();
        let uri = format!("file://{}", path.to_string_lossy().replace(' ', "%20"));
        assert_eq!(
            resolve_existing(&uri, None).unwrap(),
            path.canonicalize().unwrap()
        );
    }

    #[test]
    fn resolves_relative_paths_from_the_supplied_working_directory() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("note.txt");
        fs::write(&path, "hello").unwrap();
        let cwd = directory.path().to_str().unwrap();
        let expected = path.canonicalize().unwrap();

        assert_eq!(resolve_existing("note.txt", Some(cwd)).unwrap(), expected);
        assert_eq!(resolve_existing("./note.txt", Some(cwd)).unwrap(), expected);
    }

    #[test]
    fn saves_atomically_and_rejects_a_stale_version() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("note.rs");
        fs::write(&path, "fn before() {}\n").unwrap();
        let first = read_document(path.to_str().unwrap(), None).unwrap();
        let saved = save_document(
            path.to_str().unwrap(),
            None,
            "fn after() {}\n".into(),
            &first.version,
        )
        .unwrap();
        assert_eq!(saved.content, "fn after() {}\n");
        assert!(matches!(
            save_document(path.to_str().unwrap(), None, "stale".into(), &first.version),
            Err(FileError::Conflict)
        ));
    }

    #[test]
    fn search_skips_dependency_and_build_directories() {
        let directory = tempfile::tempdir().unwrap();
        fs::create_dir(directory.path().join("src")).unwrap();
        fs::create_dir(directory.path().join("node_modules")).unwrap();
        fs::write(directory.path().join("src/needle.rs"), "").unwrap();
        fs::write(directory.path().join("node_modules/needle.js"), "").unwrap();
        let result = search(directory.path().to_str().unwrap(), None, "needle", None).unwrap();
        assert_eq!(result.entries.len(), 1);
        assert!(result.entries[0].path.ends_with("src/needle.rs"));
    }
}
