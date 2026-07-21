use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use argon2::{
    Argon2,
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use parking_lot::Mutex;
use rand::{Rng, distr::Alphanumeric};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use thiserror::Error;
use tokio::fs;
use uuid::Uuid;

const SESSION_LIFETIME: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const CREDENTIALS_VERSION: u8 = 1;

#[derive(Debug, Error)]
pub enum AuthError {
    #[error("passwords must contain at least 8 characters")]
    ShortPassword,
    #[error("invalid credentials file: {0}")]
    InvalidCredentials(String),
    #[error("unable to hash password: {0}")]
    PasswordHash(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("password verification task failed: {0}")]
    Task(String),
}

#[derive(Debug, Serialize, Deserialize)]
struct CredentialFile {
    version: u8,
    cookie_secret: String,
    password_hash: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct SessionPayload {
    exp: u64,
    iat: u64,
    nonce: Uuid,
}

#[derive(Clone)]
pub struct AuthService {
    password_hash: Arc<str>,
    cookie_secret: Arc<[u8]>,
}

pub struct LoadedAuth {
    pub service: AuthService,
    pub generated_password: Option<String>,
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn password_hash(password: &str) -> Result<String, AuthError> {
    let salt = SaltString::encode_b64(&rand::random::<[u8; 16]>())
        .map_err(|error| AuthError::PasswordHash(error.to_string()))?;
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|error| AuthError::PasswordHash(error.to_string()))
}

async fn write_private(path: &Path, contents: &[u8]) -> Result<(), std::io::Error> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    fs::write(&temporary, contents).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600)).await?;
    }
    fs::rename(temporary, path).await?;
    Ok(())
}

pub async fn load_auth(
    data_dir: &Path,
    supplied_password: Option<String>,
    password_file: Option<&PathBuf>,
) -> Result<LoadedAuth, AuthError> {
    let path = data_dir.join("credentials.json");
    let stored = match fs::read(&path).await {
        Ok(contents) => {
            let credentials: CredentialFile = serde_json::from_slice(&contents)?;
            if credentials.version != CREDENTIALS_VERSION
                || URL_SAFE_NO_PAD.decode(&credentials.cookie_secret).is_err()
                || PasswordHash::new(&credentials.password_hash).is_err()
            {
                return Err(AuthError::InvalidCredentials(path.display().to_string()));
            }
            Some(credentials)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };

    let file_password = if let Some(password_path) = password_file {
        Some(
            fs::read_to_string(password_path)
                .await?
                .trim_end_matches(['\r', '\n'])
                .to_owned(),
        )
    } else {
        None
    };
    let supplied_password = supplied_password.or(file_password);
    if supplied_password
        .as_ref()
        .is_some_and(|value| value.len() < 8)
    {
        return Err(AuthError::ShortPassword);
    }

    let mut generated_password = None;
    let credentials = match stored {
        Some(credentials) => credentials,
        None => {
            let initial_password = supplied_password.clone().unwrap_or_else(|| {
                let password: String = rand::rng()
                    .sample_iter(Alphanumeric)
                    .take(26)
                    .map(char::from)
                    .collect();
                generated_password = Some(password.clone());
                password
            });
            let credentials = CredentialFile {
                version: CREDENTIALS_VERSION,
                cookie_secret: URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>()),
                password_hash: password_hash(&initial_password)?,
            };
            write_private(
                &path,
                serde_json::to_string_pretty(&credentials)?.as_bytes(),
            )
            .await?;
            credentials
        }
    };

    let effective_hash = supplied_password
        .as_deref()
        .map(password_hash)
        .transpose()?
        .unwrap_or(credentials.password_hash);
    Ok(LoadedAuth {
        service: AuthService {
            password_hash: effective_hash.into(),
            cookie_secret: URL_SAFE_NO_PAD
                .decode(credentials.cookie_secret)
                .map_err(|error| AuthError::InvalidCredentials(error.to_string()))?
                .into(),
        },
        generated_password,
    })
}

impl AuthService {
    pub async fn verify_password(&self, password: String) -> Result<bool, AuthError> {
        let encoded = self.password_hash.clone();
        tokio::task::spawn_blocking(move || {
            let hash = PasswordHash::new(&encoded)
                .map_err(|error| AuthError::PasswordHash(error.to_string()))?;
            Ok(Argon2::default()
                .verify_password(password.as_bytes(), &hash)
                .is_ok())
        })
        .await
        .map_err(|error| AuthError::Task(error.to_string()))?
    }

    pub fn create_session(&self) -> String {
        self.create_session_at(now_seconds())
    }

    fn create_session_at(&self, now: u64) -> String {
        let payload = SessionPayload {
            iat: now,
            exp: now + SESSION_LIFETIME.as_secs(),
            nonce: Uuid::new_v4(),
        };
        let encoded =
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).expect("serializable session"));
        let mut mac =
            Hmac::<Sha256>::new_from_slice(&self.cookie_secret).expect("HMAC accepts any key size");
        mac.update(format!("v1.{encoded}").as_bytes());
        format!(
            "v1.{encoded}.{}",
            URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
        )
    }

    pub fn verify_session(&self, token: Option<&str>) -> bool {
        self.verify_session_at(token, now_seconds())
    }

    fn verify_session_at(&self, token: Option<&str>, now: u64) -> bool {
        let Some(token) = token else { return false };
        let mut parts = token.split('.');
        let (Some("v1"), Some(encoded), Some(signature), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return false;
        };
        let Ok(signature) = URL_SAFE_NO_PAD.decode(signature) else {
            return false;
        };
        let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(&self.cookie_secret) else {
            return false;
        };
        mac.update(format!("v1.{encoded}").as_bytes());
        if mac.verify_slice(&signature).is_err() {
            return false;
        }
        let Ok(bytes) = URL_SAFE_NO_PAD.decode(encoded) else {
            return false;
        };
        let Ok(payload) = serde_json::from_slice::<SessionPayload>(&bytes) else {
            return false;
        };
        payload.iat <= now && payload.exp >= now
    }
}

#[derive(Debug, Clone, Copy)]
struct AttemptWindow {
    attempts: u8,
    resets_at: u64,
}

#[derive(Default)]
pub struct LoginLimiter {
    attempts: Mutex<HashMap<String, AttemptWindow>>,
}

impl LoginLimiter {
    pub fn consume(&self, key: &str, now: u64) -> Result<(), u64> {
        let mut attempts = self.attempts.lock();
        let window = attempts.entry(key.to_owned()).or_insert(AttemptWindow {
            attempts: 0,
            resets_at: now + 15 * 60,
        });
        if window.resets_at <= now {
            *window = AttemptWindow {
                attempts: 0,
                resets_at: now + 15 * 60,
            };
        }
        window.attempts = window.attempts.saturating_add(1);
        if window.attempts > 8 {
            Err(window.resets_at.saturating_sub(now).max(1))
        } else {
            Ok(())
        }
    }

    pub fn reset(&self, key: &str) {
        self.attempts.lock().remove(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn passwords_and_sessions_round_trip() {
        let directory = tempfile::tempdir().unwrap();
        let loaded = load_auth(directory.path(), Some("correct horse battery".into()), None)
            .await
            .unwrap();
        assert!(
            loaded
                .service
                .verify_password("correct horse battery".into())
                .await
                .unwrap()
        );
        assert!(
            !loaded
                .service
                .verify_password("not the password".into())
                .await
                .unwrap()
        );

        let token = loaded.service.create_session_at(1_000);
        assert!(loaded.service.verify_session_at(Some(&token), 1_001));
        assert!(
            !loaded
                .service
                .verify_session_at(Some(&token), 1_000 + SESSION_LIFETIME.as_secs() + 1)
        );
        assert!(
            !loaded
                .service
                .verify_session_at(Some("v1.tampered.value"), 1_001)
        );
    }

    #[tokio::test]
    async fn first_boot_generates_a_password_and_persists_only_the_hash() {
        let directory = tempfile::tempdir().unwrap();
        let loaded = load_auth(directory.path(), None, None).await.unwrap();
        let generated = loaded.generated_password.unwrap();
        let stored = fs::read_to_string(directory.path().join("credentials.json"))
            .await
            .unwrap();
        assert!(!stored.contains(&generated));
        assert!(stored.contains("$argon2"));
    }

    #[test]
    fn limiter_blocks_the_ninth_attempt() {
        let limiter = LoginLimiter::default();
        for _ in 0..8 {
            assert!(limiter.consume("client", 1_000).is_ok());
        }
        assert_eq!(limiter.consume("client", 1_000), Err(900));
        limiter.reset("client");
        assert!(limiter.consume("client", 1_000).is_ok());
    }
}
