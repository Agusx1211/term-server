use std::{
    collections::{BTreeMap, HashSet},
    env, fs, io,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::Engine;
use futures_util::{FutureExt, StreamExt, stream};
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use tokio::sync::Mutex;

const STATUS_SCHEMA_VERSION: u32 = 1;
const DEFAULT_REFRESH_SECONDS: u64 = 300;
const DEFAULT_TIMEOUT_SECONDS: u64 = 5;
const MAX_REFRESH_SECONDS: u64 = 86_400;
const MAX_TIMEOUT_SECONDS: u64 = 60;
const MAX_MODULES: usize = 64;
const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_DETAIL_ROWS: usize = 8;
const STATUS_REFRESH_CONCURRENCY: usize = 8;
const STATUS_REFRESH_DEADLINE_SECONDS: u64 = 60;
const STATUS_MIN_RETRY_SECONDS: u64 = 5;
const STATUS_MAX_RETRY_SECONDS: u64 = 300;
const SETTINGS_FILE: &str = "status-settings.json";
const SETTINGS_SCHEMA_VERSION: u32 = 1;

/// Versioned, non-secret status-line configuration loaded at startup.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StatusConfig {
    pub version: u32,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub show_on_mobile: bool,
    #[serde(default)]
    pub defaults: StatusDefaults,
    #[serde(default)]
    pub modules: Vec<StatusModuleConfig>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StatusDefaults {
    #[serde(default = "default_refresh_seconds")]
    pub refresh_seconds: u64,
    #[serde(default = "default_timeout_seconds")]
    pub timeout_seconds: u64,
}

impl Default for StatusDefaults {
    fn default() -> Self {
        Self {
            refresh_seconds: DEFAULT_REFRESH_SECONDS,
            timeout_seconds: DEFAULT_TIMEOUT_SECONDS,
        }
    }
}

fn default_refresh_seconds() -> u64 {
    DEFAULT_REFRESH_SECONDS
}

fn default_timeout_seconds() -> u64 {
    DEFAULT_TIMEOUT_SECONDS
}

/// A configured module contains only non-secret values. Credentials are
/// resolved from an allowlisted process environment variable at startup.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StatusModuleConfig {
    pub id: String,
    pub provider: String,
    pub label: String,
    #[serde(default = "default_module_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub credential_env: Option<String>,
    #[serde(default)]
    pub admin: bool,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub workspace_id: Option<String>,
}

fn default_module_enabled() -> bool {
    true
}

#[derive(Debug, Error)]
pub enum StatusConfigError {
    #[error("unable to read status configuration ({kind})")]
    Read { kind: &'static str },
    #[error("status configuration is not valid TOML schema version 1")]
    Parse,
    #[error("status configuration uses unsupported schema version {0}; expected 1")]
    UnsupportedVersion(u32),
    #[error("status configuration is invalid: duplicate module id")]
    DuplicateModuleId,
    #[error("status configuration is invalid: module id, provider, and label are required")]
    MissingModuleField,
    #[error("status configuration is invalid: module id contains unsupported characters")]
    InvalidModuleId,
    #[error("status configuration is invalid: refresh_seconds must be between 1 and 86400")]
    InvalidRefresh,
    #[error("status configuration is invalid: timeout_seconds must be between 1 and 60")]
    InvalidTimeout,
    #[error("status configuration is invalid: too many modules")]
    TooManyModules,
    #[error("status configuration is invalid: credential_env is not allowed for this provider")]
    InvalidCredentialEnvironment,
    #[error(
        "status configuration is invalid: admin credentials are supported only for OpenAI, Anthropic, or Claude"
    )]
    InvalidAdminProvider,
    #[error(
        "status configuration is invalid: project_id or workspace_id is not supported for this provider"
    )]
    InvalidProviderField,
}

impl StatusConfig {
    fn validate(&self) -> Result<(), StatusConfigError> {
        if self.version != STATUS_SCHEMA_VERSION {
            return Err(StatusConfigError::UnsupportedVersion(self.version));
        }
        if self.defaults.refresh_seconds == 0 || self.defaults.refresh_seconds > MAX_REFRESH_SECONDS
        {
            return Err(StatusConfigError::InvalidRefresh);
        }
        if self.defaults.timeout_seconds == 0 || self.defaults.timeout_seconds > MAX_TIMEOUT_SECONDS
        {
            return Err(StatusConfigError::InvalidTimeout);
        }
        if self.modules.len() > MAX_MODULES {
            return Err(StatusConfigError::TooManyModules);
        }

        let mut ids = HashSet::with_capacity(self.modules.len());
        for module in &self.modules {
            let id = module.id.trim();
            let provider = module.provider.trim().to_ascii_lowercase();
            let label = module.label.trim();
            if id.is_empty() || provider.is_empty() || label.is_empty() {
                return Err(StatusConfigError::MissingModuleField);
            }
            if label.len() > 80
                || provider.len() > 32
                || label.bytes().any(|byte| byte.is_ascii_control())
            {
                return Err(StatusConfigError::MissingModuleField);
            }
            if id.len() > 64
                || !id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
            {
                return Err(StatusConfigError::InvalidModuleId);
            }
            if !ids.insert(id.to_owned()) {
                return Err(StatusConfigError::DuplicateModuleId);
            }
            if module.admin && !matches!(provider.as_str(), "openai" | "anthropic" | "claude") {
                return Err(StatusConfigError::InvalidAdminProvider);
            }
            if (module.project_id.is_some() || module.workspace_id.is_some()) && !module.admin {
                return Err(StatusConfigError::InvalidProviderField);
            }
            if module.project_id.is_some() && provider != "openai" {
                return Err(StatusConfigError::InvalidProviderField);
            }
            if module.workspace_id.is_some() && !matches!(provider.as_str(), "anthropic" | "claude")
            {
                return Err(StatusConfigError::InvalidProviderField);
            }
            if let Some(project_id) = module.project_id.as_deref()
                && !valid_identifier(project_id)
            {
                return Err(StatusConfigError::InvalidProviderField);
            }
            if let Some(workspace_id) = module.workspace_id.as_deref()
                && !valid_identifier(workspace_id)
            {
                return Err(StatusConfigError::InvalidProviderField);
            }
            if let Some(value) = module.credential_env.as_deref()
                && !allowed_credential_environment(&provider, module.admin, value)
            {
                return Err(StatusConfigError::InvalidCredentialEnvironment);
            }
        }
        Ok(())
    }
}
fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn allowed_credential_environment(provider: &str, admin: bool, name: &str) -> bool {
    match (provider, admin) {
        ("codex", false) => matches!(
            name,
            "CODEX_API_KEY" | "CODEX_ACCESS_TOKEN" | "OPENAI_API_KEY"
        ),
        ("openai", false) => matches!(
            name,
            "CODEX_API_KEY" | "CODEX_ACCESS_TOKEN" | "OPENAI_API_KEY"
        ),
        ("openai", true) => name == "OPENAI_ADMIN_KEY",
        ("claude" | "anthropic", false) => matches!(
            name,
            "CLAUDE_CODE_OAUTH_TOKEN" | "ANTHROPIC_AUTH_TOKEN" | "ANTHROPIC_API_KEY"
        ),
        ("claude" | "anthropic", true) => name == "ANTHROPIC_ADMIN_KEY",
        ("zai", false) => name == "ZAI_API_KEY",
        _ => false,
    }
}

/// The browser-safe status payload. No credential-bearing values are present.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StatusPayload {
    pub enabled: bool,
    pub display: StatusDisplay,
    pub modules: Vec<StatusModule>,
    pub generated_at: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StatusDisplay {
    pub show_on_mobile: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum StatusModuleState {
    Ok,
    Warn,
    Error,
    Unconfigured,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StatusModule {
    pub id: String,
    pub label: String,
    pub provider: String,
    pub state: StatusModuleState,
    pub primary: Option<String>,
    pub details: Vec<StatusDetail>,
    pub refresh: StatusRefresh,
    pub error: Option<StatusError>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StatusDetail {
    pub label: String,
    pub value: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StatusRefresh {
    pub updated_at: Option<u64>,
    pub next_at: Option<u64>,
    pub interval_seconds: u64,
    pub stale: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct StatusError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

/// Browser-facing display settings for the status modules feature. These are
/// editable from the settings screen and persist in the data directory.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StatusSettings {
    pub enabled: bool,
    pub show_on_mobile: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateStatusSettings {
    pub enabled: Option<bool>,
    pub show_on_mobile: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct StoredStatusSettings {
    schema_version: u32,
    #[serde(default = "default_settings_enabled")]
    enabled: bool,
    #[serde(default)]
    show_on_mobile: bool,
}

fn default_settings_enabled() -> bool {
    true
}

impl Default for StoredStatusSettings {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            enabled: true,
            show_on_mobile: false,
        }
    }
}

struct StatusSettingsStore {
    path: Option<PathBuf>,
    state: parking_lot::RwLock<StoredStatusSettings>,
}

impl StatusSettingsStore {
    fn in_memory() -> Self {
        Self {
            path: None,
            state: parking_lot::RwLock::new(StoredStatusSettings::default()),
        }
    }

    fn load(data_directory: &Path) -> Self {
        let path = data_directory.join(SETTINGS_FILE);
        let state = match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<StoredStatusSettings>(&bytes) {
                Ok(stored) if stored.schema_version == SETTINGS_SCHEMA_VERSION => stored,
                Ok(stored) => {
                    tracing::warn!(
                        path = %path.display(),
                        schema_version = stored.schema_version,
                        "ignoring status settings with an unsupported schema"
                    );
                    StoredStatusSettings::default()
                }
                Err(error) => {
                    tracing::warn!(
                        %error,
                        path = %path.display(),
                        "ignoring invalid status settings"
                    );
                    StoredStatusSettings::default()
                }
            },
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                StoredStatusSettings::default()
            }
            Err(error) => {
                tracing::warn!(
                    %error,
                    path = %path.display(),
                    "unable to load status settings"
                );
                StoredStatusSettings::default()
            }
        };
        Self {
            path: Some(path),
            state: parking_lot::RwLock::new(state),
        }
    }

    fn snapshot(&self) -> StoredStatusSettings {
        self.state.read().clone()
    }

    fn update(&self, input: &UpdateStatusSettings) -> io::Result<StoredStatusSettings> {
        let mut state = self.state.read().clone();
        if let Some(enabled) = input.enabled {
            state.enabled = enabled;
        }
        if let Some(show_on_mobile) = input.show_on_mobile {
            state.show_on_mobile = show_on_mobile;
        }
        self.persist(&state)?;
        *self.state.write() = state.clone();
        Ok(state)
    }

    fn persist(&self, state: &StoredStatusSettings) -> io::Result<()> {
        let Some(path) = self.path.as_deref() else {
            return Ok(());
        };
        let parent = path
            .parent()
            .ok_or_else(|| io::Error::other("status settings path has no parent"))?;
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

struct SecretCredential {
    value: String,
}

/// A credential resolved for one refresh, along with a non-secret description
/// of where it came from (an environment variable or a local agent auth file).
struct ResolvedCredential {
    secret: Arc<SecretCredential>,
    source: Option<String>,
    /// ChatGPT account id required by the Codex usage endpoint; discovered
    /// alongside OAuth tokens in `$CODEX_HOME/auth.json`.
    account_id: Option<String>,
}

/// Non-secret pointers to the local agent credential stores that auto-discovery
/// reads. Files are re-read on every module refresh so re-logins and rotated
/// OAuth tokens are picked up without a server restart.
struct DiscoveryContext {
    environment: BTreeMap<String, String>,
    home: Option<PathBuf>,
    codex_home: Option<PathBuf>,
    omp_root: Option<PathBuf>,
}

impl DiscoveryContext {
    fn from_environment(environment: BTreeMap<String, String>) -> Self {
        let home = environment
            .get("HOME")
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from);
        let codex_home = environment
            .get("CODEX_HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .or_else(|| home.as_ref().map(|home| home.join(".codex")));
        // Oh My Pi keeps its root at $HOME/$PI_CONFIG_DIR, defaulting to ~/.omp.
        let omp_root = home.as_ref().map(|home| {
            let config_dir = environment
                .get("PI_CONFIG_DIR")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(".omp"));
            home.join(config_dir)
        });
        Self {
            environment,
            home,
            codex_home,
            omp_root,
        }
    }

    fn resolve(&self, provider: &str, now_ms: u64) -> Option<ResolvedCredential> {
        let environment_names: &[&str] = match provider {
            "codex" | "openai" => NORMAL_CODEX_CREDENTIALS,
            "anthropic" | "claude" => NORMAL_ANTHROPIC_CREDENTIALS,
            "zai" => &["ZAI_API_KEY"],
            _ => return None,
        };
        for name in environment_names {
            if let Some(value) = self
                .environment
                .get(*name)
                .filter(|value| !value.trim().is_empty())
            {
                return Some(resolved_credential(
                    value,
                    format!("{name} environment variable"),
                ));
            }
        }
        match provider {
            "anthropic" | "claude" => self
                .claude_credentials_file(now_ms)
                .or_else(|| self.agent_store_credential("anthropic", now_ms)),
            "codex" | "openai" => self
                .codex_auth_file()
                .or_else(|| self.agent_store_credential("openai-codex", now_ms)),
            "zai" => self.agent_store_credential("zai", now_ms),
            _ => None,
        }
    }

    fn claude_credentials_file(&self, now_ms: u64) -> Option<ResolvedCredential> {
        let path = self
            .home
            .as_ref()?
            .join(".claude")
            .join(".credentials.json");
        let value = read_json_file(&path)?;
        let oauth = value.get("claudeAiOauth")?;
        let token = non_empty_string(oauth.get("accessToken"))?;
        if expired(oauth.get("expiresAt"), now_ms) {
            return None;
        }
        Some(resolved_credential(&token, self.display_path(&path)))
    }

    fn codex_auth_file(&self) -> Option<ResolvedCredential> {
        let path = self.codex_home.as_ref()?.join("auth.json");
        let value = read_json_file(&path)?;
        if let Some(key) = non_empty_string(value.get("OPENAI_API_KEY")) {
            return Some(resolved_credential(&key, self.display_path(&path)));
        }
        let tokens = value.get("tokens");
        let token = non_empty_string(tokens.and_then(|tokens| tokens.get("access_token")))?;
        let mut resolved = resolved_credential(&token, self.display_path(&path));
        resolved.account_id = non_empty_string(tokens.and_then(|tokens| tokens.get("account_id")));
        Some(resolved)
    }

    /// pi and Oh My Pi share the auth-store format: `~/.pi/agent/auth.json` and
    /// `<omp root>/agent/auth.json` map provider names to api-key or oauth
    /// entries.
    fn agent_store_credential(&self, entry_name: &str, now_ms: u64) -> Option<ResolvedCredential> {
        let mut stores = Vec::new();
        if let Some(home) = self.home.as_ref() {
            stores.push(home.join(".pi").join("agent").join("auth.json"));
        }
        if let Some(root) = self.omp_root.as_ref() {
            stores.push(root.join("agent").join("auth.json"));
        }
        for path in stores {
            let Some(value) = read_json_file(&path) else {
                continue;
            };
            let Some(entry) = value.get(entry_name) else {
                continue;
            };
            if let Some(secret) = agent_store_entry_secret(entry, now_ms) {
                return Some(resolved_credential(&secret, self.display_path(&path)));
            }
        }
        None
    }

    fn display_path(&self, path: &Path) -> String {
        if let Some(home) = self.home.as_ref()
            && let Ok(relative) = path.strip_prefix(home)
        {
            return format!("~/{}", relative.display());
        }
        path.display().to_string()
    }
}

fn resolved_credential(secret: &str, source: String) -> ResolvedCredential {
    ResolvedCredential {
        secret: Arc::new(SecretCredential {
            value: secret.to_owned(),
        }),
        source: Some(source),
        account_id: None,
    }
}

fn read_json_file(path: &Path) -> Option<Value> {
    let bytes = fs::read(path).ok()?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

fn non_empty_string(value: Option<&Value>) -> Option<String> {
    value?
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn expired(value: Option<&Value>, now_ms: u64) -> bool {
    value
        .and_then(Value::as_f64)
        .is_some_and(|expires| expires > 0.0 && expires <= now_ms as f64)
}

fn agent_store_entry_secret(entry: &Value, now_ms: u64) -> Option<String> {
    if let Some(key) = non_empty_string(entry.get("key")) {
        return Some(key);
    }
    if expired(entry.get("expires"), now_ms) {
        return None;
    }
    non_empty_string(entry.get("access"))
}

enum ModuleCredential {
    /// Captured from the process environment at startup (TOML-configured mode).
    Static(Option<Arc<SecretCredential>>),
    /// Re-resolved from the environment and local agent auth files per refresh.
    Discovered,
}

struct RuntimeModule {
    id: String,
    label: String,
    provider: String,
    admin: bool,
    project_id: Option<String>,
    workspace_id: Option<String>,
    credential: ModuleCredential,
}

struct RuntimeConfig {
    enabled: bool,
    show_on_mobile: bool,
    defaults: StatusDefaults,
    modules: Vec<RuntimeModule>,
    /// Auto-configured mode hides modules without a discovered credential.
    auto: bool,
    discovery: Option<DiscoveryContext>,
}

struct CachedPayload {
    payload: StatusPayload,
    expires_at: u64,
}

struct CacheState {
    current: Option<CachedPayload>,
    retry_attempts: Vec<u8>,
}

/// Server-only status refresh/cache service.
///
/// Credentials are captured from the process environment during construction,
/// never serialized, and never included in the normalized payload.
#[derive(Clone)]
pub struct StatusService {
    config: Arc<RuntimeConfig>,
    settings: Arc<StatusSettingsStore>,
    cache: Arc<Mutex<CacheState>>,
    refresh_lock: Arc<Mutex<()>>,
    client: Client,
    refresh_deadline: Duration,
    endpoints: Arc<ProviderEndpoints>,
    #[cfg(test)]
    test_refresh_delays: Arc<Vec<Duration>>,
}

/// Provider quota endpoints, injectable so tests never reach the network.
struct ProviderEndpoints {
    claude_usage: String,
    codex_usage: String,
    zai_quota: String,
}

impl Default for ProviderEndpoints {
    fn default() -> Self {
        Self {
            claude_usage: "https://api.anthropic.com/api/oauth/usage".to_owned(),
            codex_usage: "https://chatgpt.com/backend-api/wham/usage".to_owned(),
            zai_quota: "https://api.z.ai/api/monitor/usage/quota/limit".to_owned(),
        }
    }
}

impl StatusService {
    /// Build the runtime service. An explicit TOML configuration wins;
    /// otherwise, when `auto` is allowed, modules are auto-configured from the
    /// local agent credential stores (~/.claude, ~/.codex, ~/.pi, ~/.omp).
    /// Display settings persist in the data directory in every mode.
    pub fn new(
        config_path: Option<&Path>,
        data_directory: &Path,
        auto: bool,
    ) -> Result<Self, StatusConfigError> {
        let mut service = match (config_path, auto) {
            (Some(path), _) => Self::from_path(Some(path))?,
            (None, true) => Self::auto(),
            (None, false) => Self::disabled(),
        };
        service.settings = Arc::new(StatusSettingsStore::load(data_directory));
        Ok(service)
    }

    pub fn disabled() -> Self {
        Self::from_runtime(RuntimeConfig {
            enabled: false,
            show_on_mobile: false,
            defaults: StatusDefaults::default(),
            modules: Vec::new(),
            auto: false,
            discovery: None,
        })
    }

    fn auto() -> Self {
        Self::auto_with_environment(env::vars())
    }

    fn auto_with_environment<I, K, V>(environment: I) -> Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<String>,
        V: Into<String>,
    {
        let environment = environment
            .into_iter()
            .map(|(name, value)| (name.into(), value.into()))
            .collect::<BTreeMap<_, _>>();
        let modules = [("claude", "Claude"), ("codex", "Codex"), ("zai", "Z.ai")]
            .into_iter()
            .map(|(provider, label)| RuntimeModule {
                id: provider.to_owned(),
                label: label.to_owned(),
                provider: provider.to_owned(),
                admin: false,
                project_id: None,
                workspace_id: None,
                credential: ModuleCredential::Discovered,
            })
            .collect();
        Self::from_runtime(RuntimeConfig {
            enabled: true,
            show_on_mobile: false,
            defaults: StatusDefaults::default(),
            modules,
            auto: true,
            discovery: Some(DiscoveryContext::from_environment(environment)),
        })
    }

    pub fn from_path(path: Option<&Path>) -> Result<Self, StatusConfigError> {
        let Some(path) = path else {
            return Ok(Self::disabled());
        };
        let text = fs::read_to_string(path).map_err(|error| StatusConfigError::Read {
            kind: match error.kind() {
                std::io::ErrorKind::NotFound => "file not found",
                std::io::ErrorKind::PermissionDenied => "permission denied",
                _ => "I/O error",
            },
        })?;
        let config = toml::from_str::<StatusConfig>(&text).map_err(|_| StatusConfigError::Parse)?;
        Self::from_config(config)
    }

    pub fn from_config(config: StatusConfig) -> Result<Self, StatusConfigError> {
        Self::from_config_with_environment(config, env::vars())
    }

    pub fn from_config_with_environment<I, K, V>(
        config: StatusConfig,
        environment: I,
    ) -> Result<Self, StatusConfigError>
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<String>,
        V: Into<String>,
    {
        config.validate()?;
        let environment = environment
            .into_iter()
            .map(|(name, value)| (name.into(), value.into()))
            .collect::<BTreeMap<_, _>>();
        let modules = config
            .modules
            .iter()
            .filter(|module| module.enabled)
            .map(|module| RuntimeModule {
                id: module.id.trim().to_owned(),
                label: module.label.trim().to_owned(),
                provider: module.provider.trim().to_ascii_lowercase(),
                admin: module.admin,
                project_id: module.project_id.clone(),
                workspace_id: module.workspace_id.clone(),
                credential: ModuleCredential::Static(resolve_credential(module, &environment)),
            })
            .collect();
        Ok(Self::from_runtime(RuntimeConfig {
            enabled: config.enabled,
            show_on_mobile: config.show_on_mobile,
            defaults: config.defaults,
            modules,
            auto: false,
            discovery: None,
        }))
    }

    fn from_runtime(config: RuntimeConfig) -> Self {
        let module_count = config.modules.len();
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("fixed status HTTP client configuration must be valid");
        Self {
            config: Arc::new(config),
            settings: Arc::new(StatusSettingsStore::in_memory()),
            cache: Arc::new(Mutex::new(CacheState {
                current: None,
                retry_attempts: vec![0; module_count],
            })),
            refresh_lock: Arc::new(Mutex::new(())),
            client,
            refresh_deadline: Duration::from_secs(STATUS_REFRESH_DEADLINE_SECONDS),
            endpoints: Arc::new(ProviderEndpoints::default()),
            #[cfg(test)]
            test_refresh_delays: Arc::new(Vec::new()),
        }
    }

    #[cfg(test)]
    fn with_test_refresh_controls(
        mut self,
        refresh_deadline: Duration,
        refresh_delays: Vec<Duration>,
    ) -> Self {
        self.refresh_deadline = refresh_deadline;
        self.test_refresh_delays = Arc::new(refresh_delays);
        self
    }

    #[cfg(test)]
    fn with_test_endpoints(mut self, endpoints: ProviderEndpoints) -> Self {
        self.endpoints = Arc::new(endpoints);
        self
    }

    /// The current settings-screen configuration for the feature.
    pub fn settings(&self) -> StatusSettings {
        let stored = self.settings.snapshot();
        StatusSettings {
            enabled: stored.enabled,
            show_on_mobile: stored.show_on_mobile,
        }
    }

    pub fn update_settings(&self, input: UpdateStatusSettings) -> io::Result<StatusSettings> {
        let stored = self.settings.update(&input)?;
        Ok(StatusSettings {
            enabled: stored.enabled,
            show_on_mobile: stored.show_on_mobile,
        })
    }

    /// Shape a cached or fresh payload for the browser: auto-configured mode
    /// hides modules without a discovered credential, and the persisted display
    /// settings override the mobile visibility default.
    fn presentable(&self, mut payload: StatusPayload) -> StatusPayload {
        if self.config.auto {
            payload
                .modules
                .retain(|module| module.state != StatusModuleState::Unconfigured);
        }
        payload.display.show_on_mobile =
            self.config.show_on_mobile || self.settings.snapshot().show_on_mobile;
        payload
    }

    pub async fn snapshot(&self) -> StatusPayload {
        let observed_at = unix_seconds();
        if !self.config.enabled || !self.settings.snapshot().enabled {
            return self.empty_payload(observed_at);
        }
        {
            let cache = self.cache.lock().await;
            if let Some(current) = cache.current.as_ref()
                && observed_at < current.expires_at
            {
                return self.presentable(current.payload.clone());
            }
        }

        let _refresh_guard = self.refresh_lock.lock().await;
        let refresh_started_at = unix_seconds();
        {
            let cache = self.cache.lock().await;
            if let Some(current) = cache.current.as_ref()
                && refresh_started_at < current.expires_at
            {
                return self.presentable(current.payload.clone());
            }
        }

        let (previous_modules, mut retry_attempts) = {
            let cache = self.cache.lock().await;
            (
                cache
                    .current
                    .as_ref()
                    .map(|current| current.payload.modules.clone())
                    .unwrap_or_default(),
                cache.retry_attempts.clone(),
            )
        };
        let mut modules = vec![None; self.config.modules.len()];
        let mut job_indices = Vec::new();
        for (index, runtime) in self.config.modules.iter().enumerate() {
            let old = previous_modules
                .iter()
                .find(|module| module.id == runtime.id);
            if let Some(previous_module) = old
                && previous_module
                    .refresh
                    .next_at
                    .is_some_and(|next_at| refresh_started_at < next_at)
            {
                modules[index] = Some(previous_module.clone());
                continue;
            }
            job_indices.push(index);
        }

        let (refreshed, unfinished) = if job_indices.is_empty() {
            (Vec::new(), Vec::new())
        } else {
            // Bounded concurrency keeps a large configuration responsive; placing
            // each result by index preserves the configured module order.
            let refresh = stream::iter(job_indices.iter().copied())
                .map({
                    move |index| async move {
                        let runtime = &self.config.modules[index];
                        (index, self.refresh_module(index, runtime).await)
                    }
                })
                .buffer_unordered(STATUS_REFRESH_CONCURRENCY);
            collect_refresh_results(refresh, &job_indices, self.refresh_deadline).await
        };
        let refresh_completed_at = unix_seconds();

        for (index, outcome) in refreshed {
            let runtime = &self.config.modules[index];
            let previous = previous_modules
                .iter()
                .find(|module| module.id == runtime.id);
            let module = match outcome {
                Ok(observation) => StatusModule {
                    id: runtime.id.clone(),
                    label: runtime.label.clone(),
                    provider: runtime.provider.clone(),
                    state: observation.state,
                    primary: observation.primary,
                    details: observation.details,
                    refresh: StatusRefresh {
                        updated_at: Some(refresh_completed_at),
                        next_at: Some(
                            refresh_completed_at
                                .saturating_add(self.config.defaults.refresh_seconds),
                        ),
                        interval_seconds: self.config.defaults.refresh_seconds,
                        stale: false,
                    },
                    error: None,
                },
                Err(failure) => failure_module(
                    runtime,
                    previous,
                    refresh_completed_at,
                    self.config.defaults.refresh_seconds,
                    retry_attempts.get(index).copied().unwrap_or_default(),
                    failure,
                ),
            };
            if module.error.as_ref().is_some_and(|error| error.retryable) {
                retry_attempts[index] = retry_attempts[index].saturating_add(1);
            } else {
                retry_attempts[index] = 0;
            }
            modules[index] = Some(module);
        }
        for index in unfinished {
            let runtime = &self.config.modules[index];
            let previous = previous_modules
                .iter()
                .find(|module| module.id == runtime.id);
            let module = failure_module(
                runtime,
                previous,
                refresh_completed_at,
                self.config.defaults.refresh_seconds,
                retry_attempts.get(index).copied().unwrap_or_default(),
                ProviderFailure::refresh_deadline(),
            );
            retry_attempts[index] = retry_attempts[index].saturating_add(1);
            modules[index] = Some(module);
        }
        let modules = modules
            .into_iter()
            .map(|module| module.expect("every configured status module has a result"))
            .collect::<Vec<_>>();
        let payload = StatusPayload {
            enabled: true,
            display: StatusDisplay {
                show_on_mobile: self.config.show_on_mobile,
            },
            modules,
            generated_at: refresh_completed_at,
        };
        let minimum_expiry = refresh_completed_at.saturating_add(1);
        let expires_at = payload
            .modules
            .iter()
            .filter_map(|module| module.refresh.next_at)
            .map(|next_at| next_at.max(minimum_expiry))
            .min()
            .unwrap_or_else(|| {
                refresh_completed_at.saturating_add(self.config.defaults.refresh_seconds)
            });
        let mut cache = self.cache.lock().await;
        cache.current = Some(CachedPayload {
            payload: payload.clone(),
            expires_at,
        });
        cache.retry_attempts = retry_attempts;
        drop(cache);
        self.presentable(payload)
    }

    fn empty_payload(&self, generated_at: u64) -> StatusPayload {
        StatusPayload {
            enabled: false,
            display: StatusDisplay {
                show_on_mobile: self.config.show_on_mobile,
            },
            modules: Vec::new(),
            generated_at,
        }
    }

    async fn refresh_module(
        &self,
        index: usize,
        runtime: &RuntimeModule,
    ) -> Result<ProviderObservation, ProviderFailure> {
        #[cfg(test)]
        if let Some(delay) = self.test_refresh_delays.get(index) {
            tokio::time::sleep(*delay).await;
        }
        #[cfg(not(test))]
        let _ = index;
        self.provider_status(runtime).await
    }

    async fn provider_status(
        &self,
        runtime: &RuntimeModule,
    ) -> Result<ProviderObservation, ProviderFailure> {
        if !matches!(
            runtime.provider.as_str(),
            "codex" | "openai" | "anthropic" | "claude" | "zai"
        ) {
            return Err(ProviderFailure::unsupported_provider());
        }
        let resolved = match &runtime.credential {
            ModuleCredential::Static(Some(secret)) => Some(ResolvedCredential {
                secret: Arc::clone(secret),
                source: None,
                account_id: None,
            }),
            ModuleCredential::Static(None) => None,
            ModuleCredential::Discovered => self
                .config
                .discovery
                .as_ref()
                .and_then(|discovery| discovery.resolve(&runtime.provider, unix_millis())),
        };
        let Some(resolved) = resolved else {
            return Ok(ProviderObservation::unconfigured());
        };
        match runtime.provider.as_str() {
            "openai" if runtime.admin => self.openai_admin_limits(runtime, &resolved.secret).await,
            "anthropic" | "claude" if runtime.admin => {
                self.anthropic_admin_limits(runtime, &resolved.secret).await
            }
            "anthropic" | "claude" => self.claude_usage(&resolved).await,
            "codex" | "openai" => self.codex_usage(&resolved).await,
            "zai" => self.zai_quota(&resolved).await,
            _ => Ok(ProviderObservation::configured_only(
                resolved.source.as_deref(),
                CONFIGURED_ONLY_NO_ENDPOINT,
            )),
        }
    }

    /// Claude subscription usage. Only OAuth access tokens (Claude Code /
    /// claude.ai logins) can read the usage endpoint; plain API keys have no
    /// subscription windows to report.
    async fn claude_usage(
        &self,
        credential: &ResolvedCredential,
    ) -> Result<ProviderObservation, ProviderFailure> {
        if !credential.secret.value.starts_with("sk-ant-oat") {
            return Ok(ProviderObservation::configured_only(
                credential.source.as_deref(),
                CONFIGURED_ONLY_NEEDS_OAUTH,
            ));
        }
        let response = self
            .get_json(
                &self.endpoints.claude_usage,
                &credential.secret,
                AuthHeader::ClaudeOauth,
            )
            .await?;
        let mut observation = parse_claude_usage(&response, unix_seconds())?;
        observation.push_source(credential.source.as_deref());
        Ok(observation)
    }

    /// Codex subscription usage. Requires a ChatGPT OAuth token (a JWT);
    /// plain OpenAI API keys cannot read the ChatGPT usage endpoint.
    async fn codex_usage(
        &self,
        credential: &ResolvedCredential,
    ) -> Result<ProviderObservation, ProviderFailure> {
        if !looks_like_jwt(&credential.secret.value) {
            return Ok(ProviderObservation::configured_only(
                credential.source.as_deref(),
                CONFIGURED_ONLY_NEEDS_OAUTH,
            ));
        }
        let account_id = credential
            .account_id
            .clone()
            .or_else(|| chatgpt_account_id_from_jwt(&credential.secret.value));
        let response = self
            .get_json(
                &self.endpoints.codex_usage,
                &credential.secret,
                AuthHeader::ChatGpt { account_id },
            )
            .await?;
        let mut observation = parse_codex_usage(&response)?;
        observation.push_source(credential.source.as_deref());
        Ok(observation)
    }

    async fn zai_quota(
        &self,
        credential: &ResolvedCredential,
    ) -> Result<ProviderObservation, ProviderFailure> {
        let response = self
            .get_json(
                &self.endpoints.zai_quota,
                &credential.secret,
                AuthHeader::Bearer,
            )
            .await?;
        let mut observation = parse_zai_quota(&response, unix_millis())?;
        observation.push_source(credential.source.as_deref());
        Ok(observation)
    }

    async fn openai_admin_limits(
        &self,
        runtime: &RuntimeModule,
        credential: &SecretCredential,
    ) -> Result<ProviderObservation, ProviderFailure> {
        let Some(project_id) = runtime.project_id.as_deref() else {
            return Ok(ProviderObservation::admin_configured_without_project());
        };
        let url =
            format!("https://api.openai.com/v1/organization/projects/{project_id}/rate_limits");
        let response = self.get_json(&url, credential, AuthHeader::Bearer).await?;
        let details = parse_openai_limits(&response)?;
        Ok(ProviderObservation {
            state: StatusModuleState::Ok,
            primary: Some("configured limits".to_owned()),
            details,
        })
    }

    async fn anthropic_admin_limits(
        &self,
        runtime: &RuntimeModule,
        credential: &SecretCredential,
    ) -> Result<ProviderObservation, ProviderFailure> {
        let workspace = runtime.workspace_id.is_some();
        let url = if let Some(workspace_id) = runtime.workspace_id.as_deref() {
            format!(
                "https://api.anthropic.com/v1/organizations/workspaces/{workspace_id}/rate_limits"
            )
        } else {
            "https://api.anthropic.com/v1/organizations/rate_limits".to_owned()
        };
        let response = self
            .get_json(&url, credential, AuthHeader::Anthropic)
            .await?;
        let details = parse_anthropic_limits(&response, workspace)?;
        Ok(ProviderObservation {
            state: StatusModuleState::Ok,
            primary: Some(if workspace {
                "workspace overrides".to_owned()
            } else {
                "configured limits".to_owned()
            }),
            details,
        })
    }

    async fn get_json(
        &self,
        url: &str,
        credential: &SecretCredential,
        header_kind: AuthHeader,
    ) -> Result<Value, ProviderFailure> {
        let mut request = self
            .client
            .get(url)
            .timeout(Duration::from_secs(self.config.defaults.timeout_seconds));
        request = match header_kind {
            AuthHeader::Bearer => request.bearer_auth(&credential.value),
            AuthHeader::Anthropic => request
                .header("x-api-key", &credential.value)
                .header("anthropic-version", "2023-06-01"),
            AuthHeader::ClaudeOauth => request
                .bearer_auth(&credential.value)
                .header("anthropic-beta", "oauth-2025-04-20"),
            AuthHeader::ChatGpt { account_id } => {
                request = request.bearer_auth(&credential.value);
                match account_id {
                    Some(account_id) => request.header("chatgpt-account-id", account_id),
                    None => request,
                }
            }
        };
        let response = request.send().await.map_err(|error| {
            if error.is_timeout() {
                ProviderFailure::timeout()
            } else {
                ProviderFailure::unavailable()
            }
        })?;
        let status = response.status();
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            return Err(ProviderFailure::auth_failed());
        }
        if status == StatusCode::TOO_MANY_REQUESTS {
            return Err(ProviderFailure::rate_limited());
        }
        if !status.is_success() {
            return Err(ProviderFailure::upstream_error(status.is_server_error()));
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
        {
            return Err(ProviderFailure::response_too_large());
        }
        let mut stream = response.bytes_stream();
        let mut body = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| ProviderFailure::unavailable())?;
            if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                return Err(ProviderFailure::response_too_large());
            }
            body.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&body).map_err(|_| ProviderFailure::invalid_response())
    }
}

async fn collect_refresh_results<S, T>(
    pending: S,
    job_indices: &[usize],
    deadline_duration: Duration,
) -> (Vec<(usize, T)>, Vec<usize>)
where
    S: futures_util::Stream<Item = (usize, T)>,
{
    let mut pending = Box::pin(pending);
    let mut completed = HashSet::with_capacity(job_indices.len());
    let mut results = Vec::with_capacity(job_indices.len());
    let deadline = tokio::time::sleep(deadline_duration);
    tokio::pin!(deadline);

    loop {
        tokio::select! {
            result = pending.next() => {
                let Some((index, result)) = result else {
                    break;
                };
                completed.insert(index);
                results.push((index, result));
            }
            _ = &mut deadline => {
                while let Some((index, result)) = pending.next().now_or_never().flatten() {
                    completed.insert(index);
                    results.push((index, result));
                }
                break;
            }
        }
    }

    let unfinished = job_indices
        .iter()
        .copied()
        .filter(|index| !completed.contains(index))
        .collect();
    (results, unfinished)
}

enum AuthHeader {
    Bearer,
    Anthropic,
    ClaudeOauth,
    ChatGpt { account_id: Option<String> },
}

struct ProviderObservation {
    state: StatusModuleState,
    primary: Option<String>,
    details: Vec<StatusDetail>,
}

impl ProviderObservation {
    fn unconfigured() -> Self {
        Self {
            state: StatusModuleState::Unconfigured,
            primary: None,
            details: vec![detail("Source", "credential is not configured")],
        }
    }

    fn configured_only(source: Option<&str>, reason: &str) -> Self {
        let mut observation = Self {
            state: StatusModuleState::Warn,
            primary: Some("configured".to_owned()),
            details: vec![detail("Quota", reason)],
        };
        observation.push_source(source);
        observation
    }

    fn push_source(&mut self, source: Option<&str>) {
        if let Some(source) = source {
            self.details.push(detail("Source", source));
        }
    }

    fn admin_configured_without_project() -> Self {
        Self {
            state: StatusModuleState::Warn,
            primary: Some("configured".to_owned()),
            details: vec![detail(
                "Quota",
                "project_id is required for configured OpenAI limits",
            )],
        }
    }
}

#[derive(Debug)]
struct ProviderFailure {
    code: &'static str,
    message: &'static str,
    retryable: bool,
}

impl ProviderFailure {
    const fn unsupported_provider() -> Self {
        Self {
            code: "unsupported_provider",
            message: "This provider is not supported.",
            retryable: false,
        }
    }

    const fn timeout() -> Self {
        Self {
            code: "timeout",
            message: "Provider status request timed out.",
            retryable: true,
        }
    }

    const fn unavailable() -> Self {
        Self {
            code: "upstream_unavailable",
            message: "Provider status is temporarily unavailable.",
            retryable: true,
        }
    }

    const fn auth_failed() -> Self {
        Self {
            code: "auth_failed",
            message: "Provider authentication failed.",
            retryable: false,
        }
    }

    const fn rate_limited() -> Self {
        Self {
            code: "rate_limited",
            message: "Provider temporarily rate limited status requests.",
            retryable: true,
        }
    }

    const fn upstream_error(retryable: bool) -> Self {
        Self {
            code: "upstream_error",
            message: "Provider status request failed.",
            retryable,
        }
    }

    const fn response_too_large() -> Self {
        Self {
            code: "response_too_large",
            message: "Provider status response was too large.",
            retryable: false,
        }
    }

    const fn invalid_response() -> Self {
        Self {
            code: "invalid_response",
            message: "Provider returned an invalid status response.",
            retryable: false,
        }
    }

    const fn refresh_deadline() -> Self {
        Self {
            code: "refresh_deadline",
            message: "Provider status refresh exceeded its time budget.",
            retryable: true,
        }
    }
}

fn retry_delay_seconds(interval_seconds: u64, retry_attempt: u8) -> u64 {
    let base = interval_seconds.max(STATUS_MIN_RETRY_SECONDS);
    let multiplier = 1_u64 << retry_attempt.min(6);
    base.saturating_mul(multiplier)
        .min(STATUS_MAX_RETRY_SECONDS.max(base))
}

fn failure_module(
    runtime: &RuntimeModule,
    previous: Option<&StatusModule>,
    now: u64,
    interval_seconds: u64,
    retry_attempt: u8,
    failure: ProviderFailure,
) -> StatusModule {
    let retry = StatusError {
        code: failure.code.to_owned(),
        message: failure.message.to_owned(),
        retryable: failure.retryable,
    };
    let next_delay = if failure.retryable {
        retry_delay_seconds(interval_seconds, retry_attempt)
    } else {
        interval_seconds
    };
    if let Some(previous) = previous
        && previous.refresh.updated_at.is_some()
        && matches!(
            previous.state,
            StatusModuleState::Ok | StatusModuleState::Warn
        )
    {
        return StatusModule {
            id: runtime.id.clone(),
            label: runtime.label.clone(),
            provider: runtime.provider.clone(),
            state: StatusModuleState::Warn,
            primary: previous.primary.clone(),
            details: previous.details.clone(),
            refresh: StatusRefresh {
                updated_at: previous.refresh.updated_at,
                next_at: Some(now.saturating_add(next_delay)),
                interval_seconds,
                stale: true,
            },
            error: Some(retry),
        };
    }
    StatusModule {
        id: runtime.id.clone(),
        label: runtime.label.clone(),
        provider: runtime.provider.clone(),
        state: StatusModuleState::Error,
        primary: None,
        details: Vec::new(),
        refresh: StatusRefresh {
            updated_at: None,
            next_at: Some(now.saturating_add(next_delay)),
            interval_seconds,
            stale: false,
        },
        error: Some(retry),
    }
}

const NORMAL_CODEX_CREDENTIALS: &[&str] =
    &["CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_API_KEY"];
const NORMAL_ANTHROPIC_CREDENTIALS: &[&str] = &[
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
];

fn resolve_credential(
    module: &StatusModuleConfig,
    environment: &BTreeMap<String, String>,
) -> Option<Arc<SecretCredential>> {
    let resolve = |names: &[&str]| {
        names.iter().find_map(|name| {
            environment.get(*name).and_then(|value| {
                (!value.trim().is_empty()).then(|| {
                    Arc::new(SecretCredential {
                        value: value.to_owned(),
                    })
                })
            })
        })
    };
    if let Some(name) = module.credential_env.as_deref() {
        return resolve(&[name]);
    }

    let provider = module.provider.trim().to_ascii_lowercase();
    let candidates = if module.admin {
        match provider.as_str() {
            "openai" => &["OPENAI_ADMIN_KEY"][..],
            "anthropic" | "claude" => &["ANTHROPIC_ADMIN_KEY"][..],
            _ => &[],
        }
    } else {
        match provider.as_str() {
            "codex" | "openai" => NORMAL_CODEX_CREDENTIALS,
            "anthropic" | "claude" => NORMAL_ANTHROPIC_CREDENTIALS,
            "zai" => &["ZAI_API_KEY"][..],
            _ => &[],
        }
    };
    resolve(candidates)
}

fn detail(label: &str, value: &str) -> StatusDetail {
    StatusDetail {
        label: label.to_owned(),
        value: value.to_owned(),
    }
}

const CONFIGURED_ONLY_NO_ENDPOINT: &str =
    "configured credential; provider publishes no standalone quota endpoint";
const CONFIGURED_ONLY_NEEDS_OAUTH: &str =
    "API key configured; usage windows are only published for OAuth (subscription) credentials";
const USAGE_WARN_PERCENT: u64 = 90;

/// One provider rate-limit window, normalized across providers so every
/// module renders the same way: worst percent as the pill primary, one
/// popover row per window.
struct UsageWindow {
    label: String,
    percent: u64,
    resets_in: Option<u64>,
    used_of: Option<(u64, u64)>,
}

fn observation_from_windows(
    windows: Vec<UsageWindow>,
    extra: Vec<StatusDetail>,
) -> Result<ProviderObservation, ProviderFailure> {
    let max_percent = windows
        .iter()
        .map(|window| window.percent)
        .max()
        .ok_or_else(ProviderFailure::invalid_response)?;
    let mut details = Vec::new();
    for window in &windows {
        let mut value = format!("{}% used", window.percent);
        if let Some((used, total)) = window.used_of {
            value.push_str(&format!(" ({used}/{total})"));
        }
        if let Some(resets_in) = window.resets_in {
            value.push_str(&format!(" · resets in {}", format_duration(resets_in)));
        }
        details.push(detail(&window.label, &value));
    }
    details.extend(extra);
    Ok(ProviderObservation {
        state: if max_percent >= USAGE_WARN_PERCENT {
            StatusModuleState::Warn
        } else {
            StatusModuleState::Ok
        },
        primary: Some(format!("{max_percent}%")),
        details,
    })
}

fn percent_value(value: Option<&Value>) -> Option<u64> {
    let percent = value?.as_f64()?;
    if !percent.is_finite() || percent < 0.0 {
        return None;
    }
    Some(percent.round().min(999.0) as u64)
}

fn format_duration(seconds: u64) -> String {
    let minutes = seconds / 60;
    let (days, hours, mins) = (minutes / 1440, (minutes % 1440) / 60, minutes % 60);
    if days > 0 {
        if hours > 0 {
            format!("{days}d {hours}h")
        } else {
            format!("{days}d")
        }
    } else if hours > 0 {
        if mins > 0 {
            format!("{hours}h {mins}m")
        } else {
            format!("{hours}h")
        }
    } else {
        format!("{}m", mins.max(1))
    }
}

fn format_window(seconds: u64) -> String {
    match seconds {
        604_800 => "Weekly".to_owned(),
        86_400 => "Daily".to_owned(),
        18_000 => "5-hour".to_owned(),
        _ if seconds.is_multiple_of(86_400) => format!("{}-day", seconds / 86_400),
        _ if seconds.is_multiple_of(3_600) => format!("{}-hour", seconds / 3_600),
        _ => format!("{}-minute", (seconds / 60).max(1)),
    }
}

fn parse_rfc3339_seconds(value: &str) -> Option<i64> {
    time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339)
        .ok()
        .map(|timestamp| timestamp.unix_timestamp())
}

fn looks_like_jwt(value: &str) -> bool {
    value.starts_with("eyJ") && value.split('.').count() == 3
}

/// The Codex usage endpoint routes by ChatGPT account. When auth.json does not
/// carry the account id, recover it from the OAuth JWT's claim payload (the
/// same claim the Codex CLI reads); the token never leaves the process.
fn chatgpt_account_id_from_jwt(token: &str) -> Option<String> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    non_empty_string(
        value
            .get("https://api.openai.com/auth")?
            .get("chatgpt_account_id"),
    )
}

fn parse_claude_usage(
    value: &Value,
    now_seconds: u64,
) -> Result<ProviderObservation, ProviderFailure> {
    let mut windows = Vec::new();
    let push = |windows: &mut Vec<UsageWindow>,
                label: String,
                percent: Option<u64>,
                resets_at: Option<&Value>| {
        let Some(percent) = percent else { return };
        let resets_in = resets_at
            .and_then(Value::as_str)
            .and_then(parse_rfc3339_seconds)
            .and_then(|reset| u64::try_from(reset).ok())
            .and_then(|reset| reset.checked_sub(now_seconds));
        windows.push(UsageWindow {
            label,
            percent,
            resets_in,
            used_of: None,
        });
    };
    if let Some(limits) = value.get("limits").and_then(Value::as_array) {
        for entry in limits.iter().take(MAX_DETAIL_ROWS) {
            let label = match entry.get("kind").and_then(Value::as_str) {
                Some("session") => "5-hour".to_owned(),
                Some("weekly_all") => "Weekly".to_owned(),
                Some("weekly_scoped") => {
                    let model = entry
                        .pointer("/scope/model/display_name")
                        .and_then(Value::as_str);
                    match model {
                        Some(model) => format!("Weekly ({model})"),
                        None => "Weekly (scoped)".to_owned(),
                    }
                }
                Some(other) => other.to_owned(),
                None => continue,
            };
            push(
                &mut windows,
                label,
                percent_value(entry.get("percent")),
                entry.get("resets_at"),
            );
        }
    }
    if windows.is_empty() {
        for (key, label) in [("five_hour", "5-hour"), ("seven_day", "Weekly")] {
            let Some(entry) = value.get(key) else {
                continue;
            };
            push(
                &mut windows,
                label.to_owned(),
                percent_value(entry.get("utilization")),
                entry.get("resets_at"),
            );
        }
    }
    observation_from_windows(windows, Vec::new())
}

fn codex_window(window: &Value, name: Option<&str>) -> Option<UsageWindow> {
    let percent = percent_value(window.get("used_percent"))?;
    let label = match name {
        Some(name) => name.to_owned(),
        None => window
            .get("limit_window_seconds")
            .and_then(Value::as_u64)
            .map(format_window)
            .unwrap_or_else(|| "Usage".to_owned()),
    };
    Some(UsageWindow {
        label,
        percent,
        resets_in: window.get("reset_after_seconds").and_then(Value::as_u64),
        used_of: None,
    })
}

fn parse_codex_usage(value: &Value) -> Result<ProviderObservation, ProviderFailure> {
    let rate_limit = value
        .get("rate_limit")
        .ok_or_else(ProviderFailure::invalid_response)?;
    let mut windows = Vec::new();
    for key in ["primary_window", "secondary_window"] {
        if let Some(window) = rate_limit.get(key)
            && let Some(window) = codex_window(window, None)
        {
            windows.push(window);
        }
    }
    if let Some(extras) = value
        .get("additional_rate_limits")
        .and_then(Value::as_array)
    {
        for entry in extras.iter().take(MAX_DETAIL_ROWS) {
            let name = entry.get("limit_name").and_then(Value::as_str);
            if let Some(window) = entry.pointer("/rate_limit/primary_window")
                && let Some(window) = codex_window(window, name)
            {
                windows.push(window);
            }
        }
    }
    let mut extra = Vec::new();
    if let Some(plan) = non_empty_string(value.get("plan_type")) {
        extra.push(detail("Plan", &plan));
    }
    observation_from_windows(windows, extra)
}

fn parse_zai_quota(value: &Value, now_ms: u64) -> Result<ProviderObservation, ProviderFailure> {
    let data = value
        .get("data")
        .ok_or_else(ProviderFailure::invalid_response)?;
    let limits = data
        .get("limits")
        .and_then(Value::as_array)
        .ok_or_else(ProviderFailure::invalid_response)?;
    let mut windows = Vec::new();
    for entry in limits.iter().take(MAX_DETAIL_ROWS) {
        let Some(percent) = percent_value(entry.get("percentage")) else {
            continue;
        };
        // The quota API describes windows as unit (3=hour, 5=day, 6=week)
        // times a count; normalize to seconds for shared labeling.
        let unit_seconds = match entry.get("unit").and_then(Value::as_u64) {
            Some(3) => Some(3_600),
            Some(5) => Some(86_400),
            Some(6) => Some(604_800),
            _ => None,
        };
        let window_text = unit_seconds
            .map(|unit| {
                format_window(entry.get("number").and_then(Value::as_u64).unwrap_or(1) * unit)
            })
            .unwrap_or_else(|| "window".to_owned());
        let label = match entry.get("type").and_then(Value::as_str) {
            Some("TIME_LIMIT") => format!("Tools ({window_text})"),
            _ => window_text,
        };
        let used_of = entry
            .get("currentValue")
            .and_then(Value::as_u64)
            .zip(entry.get("usage").and_then(Value::as_u64));
        let resets_in = entry
            .get("nextResetTime")
            .and_then(Value::as_u64)
            .and_then(|reset_ms| reset_ms.checked_sub(now_ms))
            .map(|delta_ms| delta_ms / 1000);
        windows.push(UsageWindow {
            label,
            percent,
            resets_in,
            used_of,
        });
    }
    let mut extra = Vec::new();
    if let Some(level) = non_empty_string(data.get("level")) {
        extra.push(detail("Plan", &level));
    }
    observation_from_windows(windows, extra)
}

fn parse_openai_limits(value: &Value) -> Result<Vec<StatusDetail>, ProviderFailure> {
    let entries = value
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(ProviderFailure::invalid_response)?;
    let mut request_values = Vec::new();
    let mut token_values = Vec::new();
    for entry in entries.iter().take(MAX_DETAIL_ROWS) {
        if let Some(value) = entry
            .get("max_requests_per_1_minute")
            .and_then(Value::as_u64)
        {
            request_values.push(value.to_string());
        }
        if let Some(value) = entry.get("max_tokens_per_1_minute").and_then(Value::as_u64) {
            token_values.push(value.to_string());
        }
    }
    let mut details = Vec::new();
    if !request_values.is_empty() {
        details.push(detail(
            "Configured requests/minute",
            &request_values.join(", "),
        ));
    }
    if !token_values.is_empty() {
        details.push(detail("Configured tokens/minute", &token_values.join(", ")));
    }
    if details.is_empty() {
        return Err(ProviderFailure::invalid_response());
    }
    Ok(details)
}

fn parse_anthropic_limits(
    value: &Value,
    workspace: bool,
) -> Result<Vec<StatusDetail>, ProviderFailure> {
    let groups = value
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(ProviderFailure::invalid_response)?;
    let mut limits = Vec::new();
    for group in groups.iter().take(MAX_DETAIL_ROWS) {
        let Some(entries) = group.get("limits").and_then(Value::as_array) else {
            continue;
        };
        for entry in entries.iter().take(MAX_DETAIL_ROWS) {
            let Some(number) = entry.get("value").and_then(Value::as_f64) else {
                continue;
            };
            let label = match entry.get("type").and_then(Value::as_str) {
                Some("requests") => "requests",
                Some("tokens") => "tokens",
                Some("input_tokens") => "input_tokens",
                Some("output_tokens") => "output_tokens",
                _ => "limit",
            };
            let organization = if workspace {
                entry
                    .get("org_limit")
                    .and_then(Value::as_f64)
                    .map(|value| format!(" (organization {value})"))
                    .unwrap_or_default()
            } else {
                String::new()
            };
            limits.push(format!("{label}: {number}{organization}"));
            if limits.len() >= MAX_DETAIL_ROWS {
                break;
            }
        }
    }
    if limits.is_empty() {
        return if workspace {
            Ok(vec![detail(
                "Workspace overrides",
                "none; omitted limits inherit organization settings",
            )])
        } else {
            Err(ProviderFailure::invalid_response())
        };
    }
    Ok(vec![detail(
        if workspace {
            "Workspace overrides"
        } else {
            "Configured limits"
        },
        &limits.join(", "),
    )])
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs()
}

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn module(provider: &str) -> StatusModuleConfig {
        StatusModuleConfig {
            id: provider.to_owned(),
            provider: provider.to_owned(),
            label: provider.to_owned(),
            enabled: true,
            credential_env: None,
            admin: false,
            project_id: None,
            workspace_id: None,
        }
    }

    fn static_credential(module: &RuntimeModule) -> Option<&Arc<SecretCredential>> {
        match &module.credential {
            ModuleCredential::Static(credential) => credential.as_ref(),
            ModuleCredential::Discovered => None,
        }
    }

    fn config(modules: Vec<StatusModuleConfig>) -> StatusConfig {
        StatusConfig {
            version: 1,
            enabled: true,
            show_on_mobile: false,
            defaults: StatusDefaults {
                refresh_seconds: 60,
                timeout_seconds: 5,
            },
            modules,
        }
    }

    #[tokio::test]
    async fn validates_version_order_and_duplicate_ids() {
        let mut value = config(vec![module("codex"), module("zai")]);
        assert!(
            StatusService::from_config_with_environment(
                value.clone(),
                std::iter::empty::<(String, String)>()
            )
            .is_ok()
        );
        value.modules.push(module("codex"));
        assert!(matches!(
            StatusService::from_config_with_environment(
                value,
                std::iter::empty::<(String, String)>()
            ),
            Err(StatusConfigError::DuplicateModuleId)
        ));
    }

    #[test]
    fn rejects_provider_fields_that_have_no_effect() {
        let mut openai = module("openai");
        openai.project_id = Some("project-123".to_owned());
        assert!(matches!(
            StatusService::from_config_with_environment(
                config(vec![openai]),
                std::iter::empty::<(String, String)>()
            ),
            Err(StatusConfigError::InvalidProviderField)
        ));

        let mut openai = module("openai");
        openai.admin = true;
        openai.workspace_id = Some("workspace-123".to_owned());
        assert!(matches!(
            StatusService::from_config_with_environment(
                config(vec![openai]),
                std::iter::empty::<(String, String)>()
            ),
            Err(StatusConfigError::InvalidProviderField)
        ));

        let mut anthropic = module("anthropic");
        anthropic.admin = true;
        anthropic.project_id = Some("project-123".to_owned());
        assert!(matches!(
            StatusService::from_config_with_environment(
                config(vec![anthropic]),
                std::iter::empty::<(String, String)>()
            ),
            Err(StatusConfigError::InvalidProviderField)
        ));
    }

    #[tokio::test]
    async fn credential_precedence_is_provider_specific_and_secret_free() {
        let environment = [
            ("CODEX_API_KEY", "first-secret"),
            ("CODEX_ACCESS_TOKEN", "second-secret"),
            ("OPENAI_API_KEY", "third-secret"),
        ];
        let service =
            StatusService::from_config_with_environment(config(vec![module("codex")]), environment)
                .unwrap();
        assert_eq!(
            static_credential(&service.config.modules[0])
                .expect("credential should resolve")
                .value,
            "first-secret"
        );
        let payload = service.snapshot().await;
        let json = serde_json::to_string(&payload).unwrap();
        assert!(!json.contains("first-secret"));
        assert!(!json.contains("second-secret"));
        assert!(!json.contains("third-secret"));

        let mut admin = module("openai");
        admin.admin = true;
        admin.project_id = Some("project-123".to_owned());
        let admin_service = StatusService::from_config_with_environment(
            config(vec![admin]),
            [
                ("OPENAI_ADMIN_KEY", "admin-secret"),
                ("OPENAI_API_KEY", "normal-secret"),
            ],
        )
        .unwrap();
        assert_eq!(
            static_credential(&admin_service.config.modules[0])
                .expect("admin credential should resolve")
                .value,
            "admin-secret"
        );
    }

    #[tokio::test]
    async fn missing_credentials_are_unconfigured_without_provider_io() {
        let service = StatusService::from_config_with_environment(
            config(vec![module("codex"), module("anthropic"), module("zai")]),
            std::iter::empty::<(String, String)>(),
        )
        .unwrap();
        let payload = service.snapshot().await;
        assert_eq!(
            payload
                .modules
                .iter()
                .map(|module| &module.state)
                .collect::<Vec<_>>(),
            vec![
                &StatusModuleState::Unconfigured,
                &StatusModuleState::Unconfigured,
                &StatusModuleState::Unconfigured
            ]
        );
    }

    #[tokio::test]
    async fn large_configured_sets_keep_deterministic_order() {
        let modules = (0..MAX_MODULES)
            .map(|index| {
                let mut module = module("codex");
                module.id = format!("module-{index:02}");
                module.label = module.id.clone();
                module
            })
            .collect();
        let service = StatusService::from_config_with_environment(
            config(modules),
            std::iter::empty::<(String, String)>(),
        )
        .unwrap();
        let payload = service.snapshot().await;
        assert_eq!(payload.modules.len(), MAX_MODULES);
        assert_eq!(payload.modules[0].id, "module-00");
        assert_eq!(
            payload.modules[MAX_MODULES - 1].id,
            format!("module-{:02}", MAX_MODULES - 1)
        );
        assert!(
            payload
                .modules
                .iter()
                .all(|module| module.state == StatusModuleState::Unconfigured)
        );
    }

    #[test]
    fn provider_failures_use_fixed_sanitized_messages() {
        let failure = ProviderFailure::upstream_error(false);
        assert_eq!(failure.code, "upstream_error");
        assert_eq!(failure.message, "Provider status request failed.");
        assert!(!failure.message.contains("Authorization"));
    }

    #[test]
    fn retryable_failures_use_bounded_exponential_backoff() {
        assert_eq!(retry_delay_seconds(1, 0), STATUS_MIN_RETRY_SECONDS);
        assert_eq!(retry_delay_seconds(1, 1), STATUS_MIN_RETRY_SECONDS * 2);
        assert_eq!(retry_delay_seconds(60, 3), STATUS_MAX_RETRY_SECONDS);
        assert_eq!(retry_delay_seconds(86_400, 1), 86_400);

        let deadline = ProviderFailure::refresh_deadline();
        assert_eq!(deadline.code, "refresh_deadline");
        assert!(deadline.retryable);
    }

    #[test]
    fn anthropic_workspace_limits_are_explicit_overrides() {
        let value = serde_json::json!({
            "data": [{
                "limits": [
                    {"type": "requests", "value": 100, "org_limit": 200},
                    {"type": "tokens", "value": null, "org_limit": 300}
                ]
            }]
        });
        let details = parse_anthropic_limits(&value, true).unwrap();
        assert_eq!(details[0].label, "Workspace overrides");
        assert_eq!(details[0].value, "requests: 100 (organization 200)");

        let inherited = serde_json::json!({
            "data": [{"limits": [{"type": "requests", "value": null}]}]
        });
        let details = parse_anthropic_limits(&inherited, true).unwrap();
        assert_eq!(details[0].label, "Workspace overrides");
        assert!(details[0].value.contains("inherit organization settings"));
        assert!(parse_anthropic_limits(&serde_json::json!({"data": []}), false).is_err());
    }

    #[test]
    fn stale_snapshot_preserves_prior_good_value() {
        let previous = StatusModule {
            id: "codex".to_owned(),
            label: "Codex".to_owned(),
            provider: "codex".to_owned(),
            state: StatusModuleState::Ok,
            primary: Some("25% used".to_owned()),
            details: vec![detail("Window", "15 minutes")],
            refresh: StatusRefresh {
                updated_at: Some(100),
                next_at: Some(200),
                interval_seconds: 60,
                stale: false,
            },
            error: None,
        };
        let stale = failure_module(
            &RuntimeModule {
                id: "codex".to_owned(),
                label: "Codex".to_owned(),
                provider: "codex".to_owned(),
                admin: false,
                project_id: None,
                workspace_id: None,
                credential: ModuleCredential::Static(None),
            },
            Some(&previous),
            300,
            60,
            0,
            ProviderFailure::timeout(),
        );
        assert_eq!(stale.primary, previous.primary);
        assert!(stale.refresh.stale);
        assert_eq!(stale.state, StatusModuleState::Warn);
        assert_eq!(stale.error.as_ref().unwrap().code, "timeout");
    }

    #[tokio::test]
    async fn refresh_deadline_preserves_completed_modules_and_future_deadlines() {
        let mut slow = module("codex");
        slow.id = "slow".to_owned();
        slow.label = "Slow".to_owned();
        let service = StatusService::from_config_with_environment(
            config(vec![module("codex"), slow]),
            std::iter::empty::<(String, String)>(),
        )
        .unwrap()
        .with_test_refresh_controls(
            Duration::from_millis(20),
            vec![Duration::ZERO, Duration::from_millis(200)],
        );

        let payload = service.snapshot().await;
        let fast = &payload.modules[0];
        let slow = &payload.modules[1];
        assert_eq!(fast.state, StatusModuleState::Unconfigured);
        assert!(fast.error.is_none());
        assert_eq!(
            slow.error.as_ref().map(|error| error.code.as_str()),
            Some("refresh_deadline")
        );
        assert!(
            fast.refresh.next_at.expect("fast next_at") > payload.generated_at,
            "fast module deadline must be based on refresh completion"
        );
        assert!(
            slow.refresh.next_at.expect("slow next_at") > payload.generated_at,
            "retry deadline must be based on refresh completion"
        );
        let cache = service.cache.lock().await;
        assert!(
            cache.current.as_ref().expect("cached payload").expires_at > payload.generated_at,
            "cache expiration must remain future-relative after a deadline"
        );
    }

    #[tokio::test]
    async fn waiters_reuse_snapshot_published_after_slow_refresh() {
        let mut status_config = config(vec![module("codex")]);
        status_config.defaults.refresh_seconds = 1;
        let service = Arc::new(
            StatusService::from_config_with_environment(
                status_config,
                std::iter::empty::<(String, String)>(),
            )
            .unwrap()
            .with_test_refresh_controls(Duration::from_secs(3), vec![Duration::from_millis(1_100)]),
        );

        let first_task = {
            let service = Arc::clone(&service);
            tokio::spawn(async move { service.snapshot().await })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        let second_task = {
            let service = Arc::clone(&service);
            tokio::spawn(async move { service.snapshot().await })
        };
        let first = first_task.await.unwrap();
        let second = second_task.await.unwrap();

        assert_eq!(
            first, second,
            "a waiter must return the snapshot just published by the refresh"
        );
        let cache = service.cache.lock().await;
        assert!(
            cache.current.as_ref().expect("cached payload").expires_at > first.generated_at,
            "published cache must expire after, not during, the refresh"
        );
    }

    fn write_json(path: &Path, value: serde_json::Value) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
    }

    /// Endpoints that refuse connections immediately, so no unit test ever
    /// reaches a real provider even when a discovered credential looks live.
    fn unroutable_endpoints() -> ProviderEndpoints {
        ProviderEndpoints {
            claude_usage: "http://127.0.0.1:9/claude".to_owned(),
            codex_usage: "http://127.0.0.1:9/codex".to_owned(),
            zai_quota: "http://127.0.0.1:9/zai".to_owned(),
        }
    }

    async fn serve_json(body: serde_json::Value) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let body = serde_json::to_string(&body).unwrap();
            while let Ok((mut stream, _)) = listener.accept().await {
                let mut buffer = [0_u8; 8192];
                let _ = stream.read(&mut buffer).await;
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.shutdown().await;
            }
        });
        format!("http://{address}")
    }

    fn auto_service(home: &Path, extra: &[(&str, &str)]) -> StatusService {
        let mut environment = vec![("HOME".to_owned(), home.display().to_string())];
        for (name, value) in extra {
            environment.push(((*name).to_owned(), (*value).to_owned()));
        }
        StatusService::auto_with_environment(environment)
            .with_test_endpoints(unroutable_endpoints())
    }

    #[tokio::test]
    async fn auto_mode_discovers_claude_and_hides_missing_providers() {
        let home = tempfile::tempdir().unwrap();
        write_json(
            &home.path().join(".claude/.credentials.json"),
            serde_json::json!({
                "claudeAiOauth": {
                    "accessToken": "claude-oauth-secret",
                    "expiresAt": (unix_millis() + 3_600_000),
                }
            }),
        );
        let payload = auto_service(home.path(), &[]).snapshot().await;
        assert!(payload.enabled);
        assert_eq!(
            payload
                .modules
                .iter()
                .map(|module| module.id.as_str())
                .collect::<Vec<_>>(),
            vec!["claude"],
            "providers without credentials must stay hidden"
        );
        let module = &payload.modules[0];
        assert_eq!(module.state, StatusModuleState::Warn);
        assert_eq!(module.primary.as_deref(), Some("configured"));
        assert!(module.details.iter().any(
            |detail| detail.label == "Source" && detail.value == "~/.claude/.credentials.json"
        ));
        let json = serde_json::to_string(&payload).unwrap();
        assert!(!json.contains("claude-oauth-secret"));
    }

    #[tokio::test]
    async fn auto_mode_skips_expired_tokens_and_reads_agent_stores() {
        let home = tempfile::tempdir().unwrap();
        write_json(
            &home.path().join(".claude/.credentials.json"),
            serde_json::json!({
                "claudeAiOauth": { "accessToken": "stale-secret", "expiresAt": 1_000 }
            }),
        );
        write_json(
            &home.path().join(".codex/auth.json"),
            serde_json::json!({
                "OPENAI_API_KEY": null,
                "tokens": { "access_token": "codex-oauth-secret" }
            }),
        );
        write_json(
            &home.path().join(".pi/agent/auth.json"),
            serde_json::json!({ "zai": { "type": "api_key", "key": "zai-secret" } }),
        );
        let zai_quota = serve_json(serde_json::json!({
            "code": 200,
            "data": {
                "limits": [
                    { "type": "TOKENS_LIMIT", "unit": 3, "number": 5, "percentage": 1,
                      "nextResetTime": unix_millis() + 7_200_000 },
                    { "type": "TIME_LIMIT", "unit": 5, "number": 1, "usage": 1000,
                      "currentValue": 167, "percentage": 16,
                      "nextResetTime": unix_millis() + 3_600_000 },
                ],
                "level": "pro",
            },
        }))
        .await;
        let payload = auto_service(home.path(), &[])
            .with_test_endpoints(ProviderEndpoints {
                zai_quota,
                ..unroutable_endpoints()
            })
            .snapshot()
            .await;
        assert_eq!(
            payload
                .modules
                .iter()
                .map(|module| module.id.as_str())
                .collect::<Vec<_>>(),
            vec!["codex", "zai"],
            "expired claude oauth token must not count as configured"
        );
        assert!(
            payload.modules[0]
                .details
                .iter()
                .any(|detail| detail.value == "~/.codex/auth.json")
        );
        let zai = &payload.modules[1];
        assert_eq!(zai.state, StatusModuleState::Ok);
        assert_eq!(zai.primary.as_deref(), Some("16%"));
        assert!(
            zai.details
                .iter()
                .any(|detail| detail.label == "Tools (Daily)"
                    && detail.value.starts_with("16% used (167/1000) · resets in"))
        );
        assert!(
            zai.details
                .iter()
                .any(|detail| detail.value == "~/.pi/agent/auth.json")
        );
        let json = serde_json::to_string(&payload).unwrap();
        assert!(!json.contains("zai-secret"));
    }

    #[tokio::test]
    async fn auto_mode_prefers_environment_and_reads_omp_store() {
        let home = tempfile::tempdir().unwrap();
        write_json(
            &home.path().join(".omp/agent/auth.json"),
            serde_json::json!({
                "zai": { "key": "omp-zai-secret" },
                "openai-codex": { "access": "omp-codex-secret", "expires": 0 }
            }),
        );
        let payload = auto_service(home.path(), &[("ANTHROPIC_API_KEY", "environment-secret")])
            .snapshot()
            .await;
        assert_eq!(
            payload
                .modules
                .iter()
                .map(|module| module.id.as_str())
                .collect::<Vec<_>>(),
            vec!["claude", "codex", "zai"]
        );
        assert!(
            payload.modules[0]
                .details
                .iter()
                .any(|detail| detail.value == "ANTHROPIC_API_KEY environment variable")
        );
        assert!(
            payload.modules[1]
                .details
                .iter()
                .any(|detail| detail.value == "~/.omp/agent/auth.json")
        );
    }

    #[tokio::test]
    async fn settings_default_on_persist_and_gate_the_snapshot() {
        let data_dir = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        write_json(
            &home.path().join(".pi/agent/auth.json"),
            serde_json::json!({ "zai": { "key": "zai-secret" } }),
        );
        let mut service = auto_service(home.path(), &[]);
        service.settings = Arc::new(StatusSettingsStore::load(data_dir.path()));
        assert!(service.settings().enabled, "settings must default to on");
        assert!(!service.settings().show_on_mobile);
        assert!(service.snapshot().await.enabled);

        let updated = service
            .update_settings(UpdateStatusSettings {
                enabled: Some(false),
                show_on_mobile: Some(true),
            })
            .unwrap();
        assert!(!updated.enabled);
        let disabled = service.snapshot().await;
        assert!(!disabled.enabled);
        assert!(disabled.modules.is_empty());

        // A fresh instance reloads the persisted settings from disk.
        let reloaded = StatusService::new(None, data_dir.path(), false).unwrap();
        assert!(!reloaded.settings().enabled);
        assert!(reloaded.settings().show_on_mobile);

        service
            .update_settings(UpdateStatusSettings {
                enabled: Some(true),
                show_on_mobile: None,
            })
            .unwrap();
        let restored = service.snapshot().await;
        assert!(restored.enabled);
        assert!(
            restored.display.show_on_mobile,
            "persisted show_on_mobile must override the runtime default"
        );
    }

    fn detail_value<'a>(observation: &'a ProviderObservation, label: &str) -> &'a str {
        observation
            .details
            .iter()
            .find(|entry| entry.label == label)
            .unwrap_or_else(|| panic!("missing detail row {label}"))
            .value
            .as_str()
    }

    #[test]
    fn claude_usage_prefers_limit_windows_and_reports_worst_percent() {
        let now = parse_rfc3339_seconds("2026-08-13T22:00:00+00:00").unwrap() as u64;
        let fixture = serde_json::json!({
            "five_hour": { "utilization": 17.0, "resets_at": "2026-08-14T01:00:00+00:00" },
            "seven_day": { "utilization": 14.0, "resets_at": "2026-08-19T23:59:59+00:00" },
            "limits": [
                { "kind": "session", "percent": 17, "severity": "normal",
                  "resets_at": "2026-08-14T01:00:00+00:00" },
                { "kind": "weekly_all", "percent": 14,
                  "resets_at": "2026-08-19T23:59:59+00:00" },
                { "kind": "weekly_scoped", "percent": 22,
                  "resets_at": "2026-08-20T00:00:00+00:00",
                  "scope": { "model": { "display_name": "Fable" } } },
            ],
        });
        let observation = parse_claude_usage(&fixture, now).unwrap();
        assert_eq!(observation.state, StatusModuleState::Ok);
        assert_eq!(observation.primary.as_deref(), Some("22%"));
        assert_eq!(
            detail_value(&observation, "5-hour"),
            "17% used · resets in 3h"
        );
        assert_eq!(
            detail_value(&observation, "Weekly (Fable)"),
            "22% used · resets in 6d 2h"
        );
    }

    #[test]
    fn claude_usage_falls_back_to_window_objects_and_warns_when_high() {
        let now = parse_rfc3339_seconds("2026-08-13T22:00:00+00:00").unwrap() as u64;
        let fixture = serde_json::json!({
            "five_hour": { "utilization": 92.0, "resets_at": "2026-08-14T01:30:00+00:00" },
            "seven_day": { "utilization": 14.0, "resets_at": null },
        });
        let observation = parse_claude_usage(&fixture, now).unwrap();
        assert_eq!(observation.state, StatusModuleState::Warn);
        assert_eq!(observation.primary.as_deref(), Some("92%"));
        assert_eq!(
            detail_value(&observation, "5-hour"),
            "92% used · resets in 3h 30m"
        );
        assert_eq!(detail_value(&observation, "Weekly"), "14% used");
        assert!(parse_claude_usage(&serde_json::json!({}), now).is_err());
    }

    #[test]
    fn codex_usage_labels_windows_and_named_limits() {
        let fixture = serde_json::json!({
            "plan_type": "pro",
            "rate_limit": {
                "allowed": true,
                "primary_window": {
                    "used_percent": 40, "limit_window_seconds": 604_800,
                    "reset_after_seconds": 534_676, "reset_at": 1_787_196_618_u64,
                },
                "secondary_window": null,
            },
            "additional_rate_limits": [
                { "limit_name": "GPT-5.3-Codex-Spark",
                  "rate_limit": { "primary_window": {
                      "used_percent": 0, "limit_window_seconds": 604_800,
                      "reset_after_seconds": 604_800 } } },
            ],
        });
        let observation = parse_codex_usage(&fixture).unwrap();
        assert_eq!(observation.state, StatusModuleState::Ok);
        assert_eq!(observation.primary.as_deref(), Some("40%"));
        assert_eq!(
            detail_value(&observation, "Weekly"),
            "40% used · resets in 6d 4h"
        );
        assert_eq!(
            detail_value(&observation, "GPT-5.3-Codex-Spark"),
            "0% used · resets in 7d"
        );
        assert_eq!(detail_value(&observation, "Plan"), "pro");
    }

    #[test]
    fn codex_auth_file_captures_the_chatgpt_account_id() {
        let home = tempfile::tempdir().unwrap();
        write_json(
            &home.path().join(".codex/auth.json"),
            serde_json::json!({
                "tokens": { "access_token": "eyJx.eyJy.z", "account_id": "acct-777" }
            }),
        );
        let discovery = DiscoveryContext::from_environment(BTreeMap::from([(
            "HOME".to_owned(),
            home.path().display().to_string(),
        )]));
        let resolved = discovery.resolve("codex", unix_millis()).unwrap();
        assert_eq!(resolved.account_id.as_deref(), Some("acct-777"));
        assert_eq!(resolved.source.as_deref(), Some("~/.codex/auth.json"));
    }

    #[test]
    fn chatgpt_account_id_is_recovered_from_the_oauth_jwt() {
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&serde_json::json!({
                "https://api.openai.com/auth": { "chatgpt_account_id": "acct-123" }
            }))
            .unwrap(),
        );
        let token = format!("eyJhbGciOiJIUzI1NiJ9.{payload}.signature");
        assert!(looks_like_jwt(&token));
        assert_eq!(
            chatgpt_account_id_from_jwt(&token).as_deref(),
            Some("acct-123")
        );
        assert!(!looks_like_jwt("sk-proj-plain-api-key"));
    }

    #[test]
    fn window_and_duration_formatting_is_compact() {
        assert_eq!(format_window(604_800), "Weekly");
        assert_eq!(format_window(86_400), "Daily");
        assert_eq!(format_window(18_000), "5-hour");
        assert_eq!(format_window(7_200), "2-hour");
        assert_eq!(format_duration(534_676), "6d 4h");
        assert_eq!(format_duration(200), "3m");
        assert_eq!(format_duration(30), "1m");
    }
}
