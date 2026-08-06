use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

use parking_lot::RwLock;

use percent_encoding::{AsciiSet, CONTROLS, utf8_percent_encode};
use serde::{Deserialize, Serialize};

const STATE_FILE: &str = "pushover.json";
const SCHEMA_VERSION: u32 = 1;
const PUSHOVER_API: &str = "https://api.pushover.net/1/messages.json";

/// Characters that must be percent-encoded in an `application/x-www-form-urlencoded`
/// body (the unreserved set is left alone).
const FORM_ENCODE_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'&')
    .add(b'+')
    .add(b'/')
    .add(b':')
    .add(b';')
    .add(b'<')
    .add(b'=')
    .add(b'>')
    .add(b'?')
    .add(b'@')
    .add(b'[')
    .add(b']')
    .add(b'\\')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'}')
    .add(b'|');

/// How the user wants Pushover alerts delivered.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PushoverMode {
    /// No Pushover alerts.
    #[default]
    Off,
    /// Alert for every terminal whose per-terminal bell is enabled.
    Select,
    /// Alert for every terminal (per-terminal bells default to on).
    All,
}

/// Client-facing configuration. The keys are returned so the authenticated
/// settings screen can display and edit them.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushoverConfig {
    pub configured: bool,
    pub user_key: String,
    pub app_key: String,
    pub mode: PushoverMode,
    pub enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdatePushoverConfig {
    pub user_key: Option<String>,
    pub app_key: Option<String>,
    pub mode: Option<PushoverMode>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushoverNotification {
    #[serde(default)]
    pub title: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredPushover {
    schema_version: u32,
    #[serde(default)]
    user_key: String,
    #[serde(default)]
    app_key: String,
    #[serde(default)]
    mode: PushoverMode,
}

impl Default for StoredPushover {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            user_key: String::new(),
            app_key: String::new(),
            mode: PushoverMode::Off,
        }
    }
}

pub struct PushoverService {
    path: Option<Arc<PathBuf>>,
    state: RwLock<StoredPushover>,
    client: reqwest::Client,
}

impl PushoverService {
    pub fn new(data_directory: &Path) -> Self {
        let path = data_directory.join(STATE_FILE);
        let state = match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<StoredPushover>(&bytes) {
                Ok(stored) if stored.schema_version == SCHEMA_VERSION => stored,
                Ok(stored) => {
                    tracing::warn!(
                        path = %path.display(),
                        schema_version = stored.schema_version,
                        "ignoring pushover config with an unsupported schema"
                    );
                    StoredPushover::default()
                }
                Err(error) => {
                    tracing::warn!(
                        %error,
                        path = %path.display(),
                        "ignoring invalid pushover config"
                    );
                    StoredPushover::default()
                }
            },
            Err(error) if error.kind() == io::ErrorKind::NotFound => StoredPushover::default(),
            Err(error) => {
                tracing::warn!(
                    %error,
                    path = %path.display(),
                    "unable to load pushover config"
                );
                StoredPushover::default()
            }
        };
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let client = reqwest::Client::builder()
            .user_agent(concat!("term-server/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .expect("valid pushover HTTP client");
        Self {
            path: Some(Arc::new(path)),
            state: RwLock::new(state),
            client,
        }
    }

    #[cfg(test)]
    pub fn in_memory() -> Self {
        Self {
            path: None,
            state: RwLock::new(StoredPushover::default()),
            client: reqwest::Client::new(),
        }
    }

    pub fn client_config(&self) -> PushoverConfig {
        let state = self.state.read().clone();
        let configured = !state.user_key.is_empty() && !state.app_key.is_empty();
        PushoverConfig {
            configured,
            enabled: configured && state.mode != PushoverMode::Off,
            user_key: state.user_key,
            app_key: state.app_key,
            mode: state.mode,
        }
    }

    pub fn configured(&self) -> bool {
        let state = self.state.read();
        !state.user_key.is_empty() && !state.app_key.is_empty() && state.mode != PushoverMode::Off
    }

    pub fn update(&self, input: UpdatePushoverConfig) -> io::Result<PushoverConfig> {
        let mut state = self.state.write().clone();
        if let Some(user_key) = input.user_key {
            state.user_key = user_key.trim().to_owned();
        }
        if let Some(app_key) = input.app_key {
            state.app_key = app_key.trim().to_owned();
        }
        if let Some(mode) = input.mode {
            state.mode = mode;
        }
        self.persist(&state)?;
        *self.state.write() = state;
        Ok(self.client_config())
    }

    /// Send a Pushover notification using the stored keys. Refuses when the
    /// service is not configured or the mode is off.
    pub async fn send(&self, notification: PushoverNotification) -> Result<(), String> {
        let state = self.state.read().clone();
        if state.user_key.is_empty() || state.app_key.is_empty() {
            return Err("Pushover is not configured".to_owned());
        }
        if state.mode == PushoverMode::Off {
            return Err("Pushover alerts are turned off".to_owned());
        }
        let title = notification
            .title
            .filter(|title| !title.trim().is_empty())
            .unwrap_or_else(|| "term-server".to_owned());
        let body = format!(
            "token={}&user={}&title={}&message={}",
            utf8_percent_encode(&state.app_key, FORM_ENCODE_SET),
            utf8_percent_encode(&state.user_key, FORM_ENCODE_SET),
            utf8_percent_encode(&title, FORM_ENCODE_SET),
            utf8_percent_encode(&notification.message, FORM_ENCODE_SET),
        );
        let response = self
            .client
            .post(PUSHOVER_API)
            .header("content-type", "application/x-www-form-urlencoded")
            .body(body)
            .send()
            .await
            .map_err(|error| format!("Pushover request failed: {error}"))?;
        if !response.status().is_success() {
            return Err(format!("Pushover responded with {}", response.status()));
        }
        Ok(())
    }

    fn persist(&self, state: &StoredPushover) -> io::Result<()> {
        let Some(path) = self.path.as_deref() else {
            return Ok(());
        };
        let parent = path
            .parent()
            .ok_or_else(|| io::Error::other("pushover config path has no parent"))?;
        fs::create_dir_all(parent)?;

        let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
        serde_json::to_writer_pretty(&mut temporary, state).map_err(io::Error::other)?;
        temporary.write_all(b"\n")?;
        temporary.as_file().sync_all()?;
        temporary.persist(path).map_err(|error| error.error)?;
        sync_directory(parent)
    }
}

#[cfg(unix)]
fn sync_directory(directory: &Path) -> io::Result<()> {
    fs::File::open(directory)?.sync_all()
}

#[cfg(not(unix))]
fn sync_directory(_directory: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_unconfigured_off() {
        let service = PushoverService::in_memory();
        let config = service.client_config();
        assert!(!config.configured);
        assert!(!config.enabled);
        assert_eq!(config.mode, PushoverMode::Off);
        assert!(service.client_config().user_key.is_empty());
    }

    #[test]
    fn update_round_trips_keys_and_mode() {
        let service = PushoverService::in_memory();
        let config = service
            .update(UpdatePushoverConfig {
                user_key: Some("user-abc".into()),
                app_key: Some("app-123".into()),
                mode: Some(PushoverMode::Select),
            })
            .unwrap();
        assert!(config.configured);
        assert!(config.enabled);
        assert_eq!(config.mode, PushoverMode::Select);
        assert_eq!(config.user_key, "user-abc");
        assert_eq!(config.app_key, "app-123");
    }

    #[test]
    fn off_mode_is_not_enabled_even_when_configured() {
        let service = PushoverService::in_memory();
        service
            .update(UpdatePushoverConfig {
                user_key: Some("u".into()),
                app_key: Some("a".into()),
                mode: Some(PushoverMode::Off),
            })
            .unwrap();
        assert!(service.client_config().configured);
        assert!(!service.client_config().enabled);
        assert!(!service.configured());
    }

    #[test]
    fn send_refuses_when_not_configured() {
        let service = PushoverService::in_memory();
        let result = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(service.send(PushoverNotification {
                title: Some("t".into()),
                message: "m".into(),
            }));
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not configured"));
    }

    #[test]
    fn send_refuses_when_off() {
        let service = PushoverService::in_memory();
        service
            .update(UpdatePushoverConfig {
                user_key: Some("u".into()),
                app_key: Some("a".into()),
                mode: Some(PushoverMode::Off),
            })
            .unwrap();
        let result = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(service.send(PushoverNotification {
                title: None,
                message: "m".into(),
            }));
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("turned off"));
    }

    #[test]
    fn persistence_round_trips_across_instances() {
        let directory = tempfile::tempdir().unwrap();
        let first = PushoverService::new(directory.path());
        first
            .update(UpdatePushoverConfig {
                user_key: Some("persisted-user".into()),
                app_key: Some("persisted-app".into()),
                mode: Some(PushoverMode::All),
            })
            .unwrap();
        drop(first);

        let reloaded = PushoverService::new(directory.path());
        let config = reloaded.client_config();
        assert_eq!(config.user_key, "persisted-user");
        assert_eq!(config.app_key, "persisted-app");
        assert_eq!(config.mode, PushoverMode::All);
        assert!(config.enabled);
    }
}
