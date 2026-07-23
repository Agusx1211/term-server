use std::{
    env,
    fs::{self, File},
    path::{Component, Path, PathBuf},
    process::Command,
    time::Duration,
};

use ed25519_dalek::{Signature, Verifier, VerifyingKey, pkcs8::DecodePublicKey};
use flate2::read::GzDecoder;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::{io::AsyncWriteExt, sync::Mutex};

use crate::build;

const PUBLIC_KEY: &str = include_str!("../release/public-key.txt");
const MANIFEST_NAME: &str = "release-manifest.json";
const MANIFEST_SIGNATURE_NAME: &str = "release-manifest.json.sig";
const MAX_METADATA_BYTES: u64 = 1024 * 1024;
const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_EXTRACTED_BYTES: u64 = 1024 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateConfig {
    pub enabled: bool,
    pub channel: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current: build::BuildInfo,
    pub state: UpdateState,
    pub latest: Option<ReleaseInfo>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateState {
    Current,
    Available,
    Unavailable,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseInfo {
    pub version: String,
    pub commit: String,
    pub published_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseManifest {
    schema_version: u32,
    channel: String,
    version: String,
    commit: String,
    published_at: String,
    artifacts: Vec<ReleaseArtifact>,
}

#[derive(Debug, Clone, Deserialize)]
struct ReleaseArtifact {
    target: String,
    name: String,
    sha256: String,
    size: u64,
}

#[derive(Debug, Clone)]
struct VerifiedRelease {
    info: ReleaseInfo,
    artifact: ReleaseArtifact,
}

#[derive(Debug, Clone)]
struct Installation {
    executable: PathBuf,
    client_directory: PathBuf,
    root: PathBuf,
}

pub struct UpdateService {
    client: reqwest::Client,
    channel: String,
    release_base_url: String,
    verifying_key: VerifyingKey,
    installation: Option<Installation>,
    unavailable_reason: Option<String>,
    install_lock: Mutex<()>,
}

impl UpdateService {
    pub fn new(
        client_directory: Option<&Path>,
        channel: String,
        release_base_url: String,
        disabled: bool,
    ) -> Self {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let verifying_key =
            VerifyingKey::from_public_key_pem(PUBLIC_KEY).expect("valid release public key");
        let client = reqwest::Client::builder()
            .user_agent(concat!("term-server/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(5 * 60))
            .build()
            .expect("valid update HTTP client");
        let (installation, unavailable_reason) = if disabled {
            (None, Some("automatic updates are disabled".to_owned()))
        } else if !valid_channel(&channel) {
            (None, Some("the update channel is invalid".to_owned()))
        } else if !release_base_url.starts_with("https://") {
            (None, Some("the release base URL must use HTTPS".to_owned()))
        } else {
            match detect_installation(client_directory) {
                Ok(installation) => (Some(installation), None),
                Err(reason) => (None, Some(reason)),
            }
        };
        Self {
            client,
            channel,
            release_base_url: release_base_url.trim_end_matches('/').to_owned(),
            verifying_key,
            installation,
            unavailable_reason,
            install_lock: Mutex::new(()),
        }
    }

    pub fn config(&self) -> UpdateConfig {
        UpdateConfig {
            enabled: self.installation.is_some(),
            channel: self.channel.clone(),
            reason: self.unavailable_reason.clone(),
        }
    }

    pub async fn check(&self) -> Result<UpdateStatus, UpdateError> {
        if self.installation.is_none() {
            return Ok(UpdateStatus {
                current: build::info(),
                state: UpdateState::Unavailable,
                latest: None,
            });
        }
        let release = self.fetch_verified_release().await?;
        let state = if release.info.commit == build::COMMIT {
            UpdateState::Current
        } else {
            UpdateState::Available
        };
        Ok(UpdateStatus {
            current: build::info(),
            state,
            latest: Some(release.info),
        })
    }

    pub async fn install(&self, expected_commit: &str) -> Result<ReleaseInfo, UpdateError> {
        let installation = self
            .installation
            .as_ref()
            .ok_or_else(|| {
                UpdateError::Unsupported(
                    self.unavailable_reason
                        .clone()
                        .unwrap_or_else(|| "automatic updates are unavailable".to_owned()),
                )
            })?
            .clone();
        let _guard = self
            .install_lock
            .try_lock()
            .map_err(|_| UpdateError::Busy)?;
        let release = self.fetch_verified_release().await?;
        if release.info.commit != expected_commit {
            return Err(UpdateError::Stale);
        }
        if release.info.commit == build::COMMIT {
            return Err(UpdateError::AlreadyCurrent);
        }

        let temporary = tempfile::Builder::new()
            .prefix(".term-server-update-")
            .tempdir_in(&installation.root)
            .map_err(install_error)?;
        let archive_path = temporary.path().join(&release.artifact.name);
        self.download_artifact(&release.artifact, &archive_path)
            .await?;

        let artifact = release.artifact.clone();
        let info = release.info.clone();
        let extraction_root = temporary.path().join("extracted");
        let package_directory = tokio::task::spawn_blocking(move || {
            extract_archive(&archive_path, &extraction_root, &artifact.name)
        })
        .await
        .map_err(|error| UpdateError::Install(error.to_string()))??;
        verify_package(&package_directory, &release.info)?;
        replace_installation(&installation, &package_directory, temporary.path())?;
        Ok(info)
    }

    async fn fetch_verified_release(&self) -> Result<VerifiedRelease, UpdateError> {
        let manifest_bytes = self
            .fetch_small_file(MANIFEST_NAME, MAX_METADATA_BYTES)
            .await?;
        let signature_bytes = self.fetch_small_file(MANIFEST_SIGNATURE_NAME, 1024).await?;
        verify_signature(&self.verifying_key, &manifest_bytes, &signature_bytes)?;
        let manifest: ReleaseManifest = serde_json::from_slice(&manifest_bytes)
            .map_err(|error| UpdateError::InvalidRelease(error.to_string()))?;
        validate_manifest(manifest, &self.channel)
    }

    async fn fetch_small_file(&self, name: &str, limit: u64) -> Result<Vec<u8>, UpdateError> {
        let response = self
            .client
            .get(self.release_url(name))
            .send()
            .await?
            .error_for_status()?;
        if response
            .content_length()
            .is_some_and(|length| length > limit)
        {
            return Err(UpdateError::InvalidRelease(format!(
                "{name} exceeds the size limit"
            )));
        }
        let mut stream = response.bytes_stream();
        let mut result = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            if result.len() as u64 + chunk.len() as u64 > limit {
                return Err(UpdateError::InvalidRelease(format!(
                    "{name} exceeds the size limit"
                )));
            }
            result.extend_from_slice(&chunk);
        }
        Ok(result)
    }

    async fn download_artifact(
        &self,
        artifact: &ReleaseArtifact,
        destination: &Path,
    ) -> Result<(), UpdateError> {
        let response = self
            .client
            .get(self.release_url(&artifact.name))
            .send()
            .await?
            .error_for_status()?;
        if response
            .content_length()
            .is_some_and(|length| length != artifact.size)
        {
            return Err(UpdateError::InvalidRelease(
                "release archive size does not match its signed manifest".to_owned(),
            ));
        }

        let mut file = tokio::fs::File::create(destination)
            .await
            .map_err(install_error)?;
        let mut hasher = Sha256::new();
        let mut received = 0_u64;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            received = received.saturating_add(chunk.len() as u64);
            if received > artifact.size || received > MAX_ARCHIVE_BYTES {
                return Err(UpdateError::InvalidRelease(
                    "release archive exceeds its signed size".to_owned(),
                ));
            }
            hasher.update(&chunk);
            file.write_all(&chunk).await.map_err(install_error)?;
        }
        file.flush().await.map_err(install_error)?;
        if received != artifact.size {
            return Err(UpdateError::InvalidRelease(
                "release archive is incomplete".to_owned(),
            ));
        }
        let actual = hex_digest(hasher.finalize().as_slice());
        if actual != artifact.sha256 {
            return Err(UpdateError::ChecksumMismatch);
        }
        Ok(())
    }

    fn release_url(&self, name: &str) -> String {
        format!("{}/{}/{}", self.release_base_url, self.channel, name)
    }
}

#[derive(Debug, Error)]
pub enum UpdateError {
    #[error("automatic updates are unavailable: {0}")]
    Unsupported(String),
    #[error("another update is already in progress")]
    Busy,
    #[error("the available release changed; check for updates again")]
    Stale,
    #[error("term-server is already running this release")]
    AlreadyCurrent,
    #[error("release download failed: {0}")]
    Network(#[from] reqwest::Error),
    #[error("release signature verification failed")]
    InvalidSignature,
    #[error("release metadata is invalid: {0}")]
    InvalidRelease(String),
    #[error("release archive checksum verification failed")]
    ChecksumMismatch,
    #[error("update installation failed: {0}")]
    Install(String),
}

fn detect_installation(client_directory: Option<&Path>) -> Result<Installation, String> {
    if env::consts::OS != "linux" || release_target().is_none() {
        return Err("automatic updates currently support x86-64 and ARM64 Linux only".to_owned());
    }
    let client_directory = client_directory
        .ok_or_else(|| "automatic updates require the bundled browser client".to_owned())?;
    let executable =
        env::current_exe().map_err(|error| format!("unable to locate the executable: {error}"))?;
    let root = executable
        .parent()
        .ok_or_else(|| "the executable has no parent directory".to_owned())?
        .to_owned();
    if client_directory.file_name().and_then(|name| name.to_str()) != Some("client")
        || client_directory.parent() != Some(root.as_path())
    {
        return Err(
            "automatic updates require an installed release with term-server and client/ side by side"
                .to_owned(),
        );
    }
    Ok(Installation {
        executable,
        client_directory: client_directory.to_owned(),
        root,
    })
}

fn validate_manifest(
    manifest: ReleaseManifest,
    expected_channel: &str,
) -> Result<VerifiedRelease, UpdateError> {
    if manifest.schema_version != 1 {
        return Err(UpdateError::InvalidRelease(format!(
            "unsupported manifest schema {}",
            manifest.schema_version
        )));
    }
    if manifest.channel != expected_channel {
        return Err(UpdateError::InvalidRelease(
            "release channel does not match the configured channel".to_owned(),
        ));
    }
    if manifest.version.is_empty()
        || manifest.version.len() > 64
        || !manifest
            .version
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ".+-".contains(character))
    {
        return Err(UpdateError::InvalidRelease(
            "release version is malformed".to_owned(),
        ));
    }
    if !valid_commit(&manifest.commit) {
        return Err(UpdateError::InvalidRelease(
            "release commit is malformed".to_owned(),
        ));
    }
    if manifest.published_at.is_empty() || manifest.published_at.len() > 64 {
        return Err(UpdateError::InvalidRelease(
            "release publication time is malformed".to_owned(),
        ));
    }

    let target = release_target().ok_or_else(|| {
        UpdateError::Unsupported("this operating system or architecture is unsupported".to_owned())
    })?;
    let expected_name = release_archive_name().expect("supported release target");
    let artifact = manifest
        .artifacts
        .into_iter()
        .find(|artifact| artifact.target == target)
        .ok_or_else(|| {
            UpdateError::InvalidRelease(format!("no release archive was published for {target}"))
        })?;
    if artifact.name != expected_name
        || artifact.size == 0
        || artifact.size > MAX_ARCHIVE_BYTES
        || artifact.sha256.len() != 64
        || !artifact
            .sha256
            .chars()
            .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase())
    {
        return Err(UpdateError::InvalidRelease(
            "release artifact metadata is malformed".to_owned(),
        ));
    }

    Ok(VerifiedRelease {
        info: ReleaseInfo {
            version: manifest.version,
            commit: manifest.commit,
            published_at: manifest.published_at,
        },
        artifact,
    })
}

fn verify_signature(
    verifying_key: &VerifyingKey,
    message: &[u8],
    signature: &[u8],
) -> Result<(), UpdateError> {
    let signature = Signature::from_slice(signature).map_err(|_| UpdateError::InvalidSignature)?;
    verifying_key
        .verify(message, &signature)
        .map_err(|_| UpdateError::InvalidSignature)
}

fn extract_archive(
    archive_path: &Path,
    extraction_root: &Path,
    archive_name: &str,
) -> Result<PathBuf, UpdateError> {
    fs::create_dir(extraction_root).map_err(install_error)?;
    let package_name = archive_name
        .strip_suffix(".tar.gz")
        .ok_or_else(|| UpdateError::InvalidRelease("release archive name is invalid".to_owned()))?;
    let decoder = GzDecoder::new(File::open(archive_path).map_err(install_error)?);
    let mut archive = tar::Archive::new(decoder);
    let mut extracted_bytes = 0_u64;
    for entry in archive
        .entries()
        .map_err(|error| UpdateError::InvalidRelease(error.to_string()))?
    {
        let mut entry = entry.map_err(|error| UpdateError::InvalidRelease(error.to_string()))?;
        let path = entry
            .path()
            .map_err(|error| UpdateError::InvalidRelease(error.to_string()))?
            .into_owned();
        validate_archive_path(&path, package_name)?;
        if !entry.header().entry_type().is_file() && !entry.header().entry_type().is_dir() {
            return Err(UpdateError::InvalidRelease(
                "release archive contains a link or special file".to_owned(),
            ));
        }
        extracted_bytes = extracted_bytes.saturating_add(entry.size());
        if extracted_bytes > MAX_EXTRACTED_BYTES {
            return Err(UpdateError::InvalidRelease(
                "release archive expands beyond the size limit".to_owned(),
            ));
        }
        if !entry
            .unpack_in(extraction_root)
            .map_err(|error| UpdateError::InvalidRelease(error.to_string()))?
        {
            return Err(UpdateError::InvalidRelease(
                "release archive contains an unsafe path".to_owned(),
            ));
        }
    }
    Ok(extraction_root.join(package_name))
}

fn validate_archive_path(path: &Path, package_name: &str) -> Result<(), UpdateError> {
    let mut components = path.components();
    if components.next() != Some(Component::Normal(package_name.as_ref()))
        || components.any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(UpdateError::InvalidRelease(
            "release archive contains an unsafe path".to_owned(),
        ));
    }
    Ok(())
}

fn verify_package(package: &Path, release: &ReleaseInfo) -> Result<(), UpdateError> {
    let executable = package.join("term-server");
    let client_index = package.join("client/index.html");
    if !executable.is_file() || !client_index.is_file() {
        return Err(UpdateError::InvalidRelease(
            "release archive is missing its binary or browser client".to_owned(),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if executable
            .metadata()
            .map_err(install_error)?
            .permissions()
            .mode()
            & 0o111
            == 0
        {
            return Err(UpdateError::InvalidRelease(
                "release binary is not executable".to_owned(),
            ));
        }
    }
    let output = Command::new(&executable)
        .arg("--version")
        .output()
        .map_err(install_error)?;
    let identity = String::from_utf8_lossy(&output.stdout);
    if !output.status.success()
        || !identity.contains(&release.version)
        || !identity.contains(&release.commit)
    {
        return Err(UpdateError::InvalidRelease(
            "release binary identity does not match its signed manifest".to_owned(),
        ));
    }
    Ok(())
}

fn replace_installation(
    installation: &Installation,
    package: &Path,
    temporary: &Path,
) -> Result<(), UpdateError> {
    let candidate_binary = package.join("term-server");
    let candidate_client = package.join("client");
    let previous_binary = temporary.join("previous-term-server");
    let previous_client = temporary.join("previous-client");

    fs::rename(&installation.client_directory, &previous_client).map_err(install_error)?;
    if let Err(error) = fs::rename(&candidate_client, &installation.client_directory) {
        let _ = fs::rename(&previous_client, &installation.client_directory);
        return Err(install_error(error));
    }
    if let Err(error) = fs::rename(&installation.executable, &previous_binary) {
        rollback_client(
            &installation.client_directory,
            &candidate_client,
            &previous_client,
        );
        return Err(install_error(error));
    }
    if let Err(error) = fs::rename(&candidate_binary, &installation.executable) {
        let _ = fs::rename(&previous_binary, &installation.executable);
        rollback_client(
            &installation.client_directory,
            &candidate_client,
            &previous_client,
        );
        return Err(install_error(error));
    }
    Ok(())
}

fn rollback_client(current: &Path, candidate: &Path, previous: &Path) {
    let _ = fs::rename(current, candidate);
    let _ = fs::rename(previous, current);
}

fn install_error(error: impl std::fmt::Display) -> UpdateError {
    UpdateError::Install(error.to_string())
}

fn release_target() -> Option<&'static str> {
    match (env::consts::OS, env::consts::ARCH) {
        ("linux", "x86_64") => Some("x86_64-unknown-linux-gnu"),
        ("linux", "aarch64") => Some("aarch64-unknown-linux-gnu"),
        _ => None,
    }
}

fn release_archive_name() -> Option<&'static str> {
    match (env::consts::OS, env::consts::ARCH) {
        ("linux", "x86_64") => Some("term-server-linux-x86_64.tar.gz"),
        ("linux", "aarch64") => Some("term-server-linux-aarch64.tar.gz"),
        _ => None,
    }
}

pub fn valid_channel(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
}

fn valid_commit(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .chars()
            .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase())
}

fn hex_digest(bytes: &[u8]) -> String {
    use std::fmt::Write;

    bytes.iter().fold(
        String::with_capacity(bytes.len() * 2),
        |mut result, byte| {
            write!(result, "{byte:02x}").expect("writing to a string");
            result
        },
    )
}

#[cfg(test)]
mod tests {
    use ed25519_dalek::{Signer, SigningKey};

    use super::*;

    fn manifest() -> ReleaseManifest {
        ReleaseManifest {
            schema_version: 1,
            channel: "main".to_owned(),
            version: "0.1.0".to_owned(),
            commit: "a".repeat(40),
            published_at: "2026-07-23T00:00:00.000Z".to_owned(),
            artifacts: vec![ReleaseArtifact {
                target: release_target().unwrap().to_owned(),
                name: release_archive_name().unwrap().to_owned(),
                sha256: "b".repeat(64),
                size: 1024,
            }],
        }
    }

    #[test]
    fn validates_release_identity_and_artifact() {
        let release = validate_manifest(manifest(), "main").unwrap();
        assert_eq!(release.info.version, "0.1.0");
        assert_eq!(release.artifact.size, 1024);
    }

    #[test]
    fn rejects_another_channel_or_malformed_checksum() {
        assert!(validate_manifest(manifest(), "stable").is_err());
        let mut malformed = manifest();
        malformed.artifacts[0].sha256 = "ABC".to_owned();
        assert!(validate_manifest(malformed, "main").is_err());
    }

    #[test]
    fn verifies_ed25519_signatures_before_parsing() {
        let signing_key = SigningKey::from_bytes(&[7; 32]);
        let message = b"signed release manifest";
        let signature = signing_key.sign(message);
        verify_signature(&signing_key.verifying_key(), message, &signature.to_bytes()).unwrap();
        assert!(
            verify_signature(
                &signing_key.verifying_key(),
                b"modified manifest",
                &signature.to_bytes()
            )
            .is_err()
        );
    }

    #[test]
    fn rejects_paths_outside_the_expected_package() {
        assert!(
            validate_archive_path(
                Path::new("term-server-linux-x86_64/client/index.html"),
                "term-server-linux-x86_64"
            )
            .is_ok()
        );
        assert!(
            validate_archive_path(Path::new("../term-server"), "term-server-linux-x86_64").is_err()
        );
        assert!(
            validate_archive_path(
                Path::new("another-package/term-server"),
                "term-server-linux-x86_64"
            )
            .is_err()
        );
    }

    #[test]
    fn replaces_the_binary_and_client_together() {
        let root = tempfile::tempdir().unwrap();
        let executable = root.path().join("term-server");
        let client_directory = root.path().join("client");
        let package = root.path().join("package");
        let temporary = root.path().join("temporary");
        fs::create_dir(&client_directory).unwrap();
        fs::create_dir_all(package.join("client")).unwrap();
        fs::create_dir(&temporary).unwrap();
        fs::write(&executable, "old binary").unwrap();
        fs::write(client_directory.join("index.html"), "old client").unwrap();
        fs::write(package.join("term-server"), "new binary").unwrap();
        fs::write(package.join("client/index.html"), "new client").unwrap();

        replace_installation(
            &Installation {
                executable: executable.clone(),
                client_directory: client_directory.clone(),
                root: root.path().to_owned(),
            },
            &package,
            &temporary,
        )
        .unwrap();

        assert_eq!(fs::read_to_string(executable).unwrap(), "new binary");
        assert_eq!(
            fs::read_to_string(client_directory.join("index.html")).unwrap(),
            "new client"
        );
    }
}
