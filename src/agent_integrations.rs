use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    process::{Output, Stdio},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::process::Command;

use crate::ai::find_executable;

const MARKETPLACE_NAME: &str = "term-server-local";
const PLUGIN_NAME: &str = "term-server-agent-events";
const PLUGIN_SELECTOR: &str = "term-server-agent-events@term-server-local";
const COMMAND_TIMEOUT: Duration = Duration::from_secs(60);

const CODEX_MANIFEST: &str = include_str!("../integrations/codex/.codex-plugin/plugin.json");
const CODEX_HOOKS: &str = include_str!("../integrations/codex/hooks/hooks.json");
const CLAUDE_MANIFEST: &str = include_str!("../integrations/claude/.claude-plugin/plugin.json");
const CLAUDE_HOOKS: &str = include_str!("../integrations/claude/hooks/hooks.json");
const PI_MANIFEST: &str = include_str!("../integrations/pi/package.json");
const PI_EXTENSION: &str =
    include_str!("../integrations/pi/extensions/term-server-agent-events.ts");

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentIntegrationProvider {
    Codex,
    Claude,
    Pi,
}

impl AgentIntegrationProvider {
    fn command(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
            Self::Pi => "pi",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Codex => "Codex",
            Self::Claude => "Claude Code",
            Self::Pi => "Pi",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentIntegrationState {
    Unavailable,
    NotInstalled,
    Installed,
    NeedsRepair,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentIntegrationStatus {
    pub provider: AgentIntegrationProvider,
    pub name: String,
    pub state: AgentIntegrationState,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentIntegrationsConfig {
    pub providers: Vec<AgentIntegrationStatus>,
    pub fallbacks_enabled: bool,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentIntegrationAction {
    Install,
    Repair,
    Remove,
}

#[derive(Clone)]
pub struct AgentIntegrationService {
    root: PathBuf,
}

impl AgentIntegrationService {
    pub fn new(data_directory: &Path) -> Self {
        Self {
            root: data_directory.join("agent-integrations"),
        }
    }

    pub async fn status(&self) -> AgentIntegrationsConfig {
        let (codex, claude, pi) = tokio::join!(
            self.provider_status(AgentIntegrationProvider::Codex),
            self.provider_status(AgentIntegrationProvider::Claude),
            self.provider_status(AgentIntegrationProvider::Pi),
        );
        AgentIntegrationsConfig {
            providers: vec![codex, claude, pi],
            fallbacks_enabled: true,
        }
    }

    pub async fn apply(
        &self,
        provider: AgentIntegrationProvider,
        action: AgentIntegrationAction,
    ) -> Result<AgentIntegrationsConfig, String> {
        let executable = find_executable(provider.command()).ok_or_else(|| {
            format!(
                "{} is not installed or is not visible to term-server",
                provider.label()
            )
        })?;
        match action {
            AgentIntegrationAction::Install | AgentIntegrationAction::Repair => {
                self.install(provider, &executable).await?;
            }
            AgentIntegrationAction::Remove => {
                self.remove(provider, &executable).await?;
            }
        }
        Ok(self.status().await)
    }

    async fn provider_status(&self, provider: AgentIntegrationProvider) -> AgentIntegrationStatus {
        let Some(executable) = find_executable(provider.command()) else {
            return status(
                provider,
                AgentIntegrationState::Unavailable,
                format!("{} is not available on this server.", provider.label()),
            );
        };
        let result = match provider {
            AgentIntegrationProvider::Codex => self.codex_status(&executable).await,
            AgentIntegrationProvider::Claude => self.claude_status(&executable).await,
            AgentIntegrationProvider::Pi => self.pi_status(&executable).await,
        };
        result.unwrap_or_else(|message| {
            status(
                provider,
                AgentIntegrationState::NeedsRepair,
                format!("{message} Process/output inference is still active."),
            )
        })
    }

    async fn codex_status(&self, executable: &Path) -> Result<AgentIntegrationStatus, String> {
        let marketplace_root = self.provider_root(AgentIntegrationProvider::Codex);
        let marketplaces =
            command_json(executable, ["plugin", "marketplace", "list", "--json"]).await?;
        let plugins = command_json(executable, ["plugin", "list", "--json"]).await?;
        let marketplace = marketplace_entry(&marketplaces, MARKETPLACE_NAME);
        let registered = marketplace
            .and_then(|entry| entry.get("root"))
            .and_then(Value::as_str)
            .is_some_and(|root| paths_match(Path::new(root), &marketplace_root));
        let collision = marketplace.is_some() && !registered;
        let installed = plugin_entry(&plugins, "pluginId", PLUGIN_SELECTOR);
        let enabled = installed
            .and_then(|entry| entry.get("enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        Ok(classify_status(
            AgentIntegrationProvider::Codex,
            registered,
            collision,
            installed.is_some(),
            enabled,
            self.assets_current(AgentIntegrationProvider::Codex),
        ))
    }

    async fn claude_status(&self, executable: &Path) -> Result<AgentIntegrationStatus, String> {
        let marketplace_root = self.provider_root(AgentIntegrationProvider::Claude);
        let marketplaces =
            command_json(executable, ["plugin", "marketplace", "list", "--json"]).await?;
        let plugins = command_json(executable, ["plugin", "list", "--json"]).await?;
        let marketplace = marketplace_entry(&marketplaces, MARKETPLACE_NAME);
        let registered = marketplace
            .and_then(|entry| entry.get("installLocation"))
            .and_then(Value::as_str)
            .is_some_and(|root| paths_match(Path::new(root), &marketplace_root));
        let collision = marketplace.is_some() && !registered;
        let installed = plugin_entry(&plugins, "id", PLUGIN_SELECTOR);
        let enabled = installed
            .and_then(|entry| entry.get("enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        Ok(classify_status(
            AgentIntegrationProvider::Claude,
            registered,
            collision,
            installed.is_some(),
            enabled,
            self.assets_current(AgentIntegrationProvider::Claude),
        ))
    }

    async fn pi_status(&self, executable: &Path) -> Result<AgentIntegrationStatus, String> {
        let package_root = self.provider_root(AgentIntegrationProvider::Pi);
        let output = run_command(executable, ["list", "--no-approve"]).await?;
        let installed = package_list_contains(&output.stdout, &package_root);
        Ok(classify_status(
            AgentIntegrationProvider::Pi,
            installed,
            false,
            installed,
            installed,
            self.assets_current(AgentIntegrationProvider::Pi),
        ))
    }

    async fn install(
        &self,
        provider: AgentIntegrationProvider,
        executable: &Path,
    ) -> Result<(), String> {
        self.prepare_package(provider).await?;
        match provider {
            AgentIntegrationProvider::Codex => {
                let marketplace_root = self.provider_root(provider);
                let marketplaces =
                    command_json(executable, ["plugin", "marketplace", "list", "--json"]).await?;
                ensure_marketplace_available(&marketplaces, &marketplace_root)?;
                if marketplace_entry(&marketplaces, MARKETPLACE_NAME).is_none() {
                    run_command(
                        executable,
                        [
                            OsString::from("plugin"),
                            OsString::from("marketplace"),
                            OsString::from("add"),
                            marketplace_root.into_os_string(),
                            OsString::from("--json"),
                        ],
                    )
                    .await?;
                }
                let plugins = command_json(executable, ["plugin", "list", "--json"]).await?;
                if plugin_entry(&plugins, "pluginId", PLUGIN_SELECTOR).is_some() {
                    run_command(executable, ["plugin", "remove", PLUGIN_SELECTOR, "--json"])
                        .await?;
                }
                run_command(executable, ["plugin", "add", PLUGIN_SELECTOR, "--json"]).await?;
            }
            AgentIntegrationProvider::Claude => {
                let marketplace_root = self.provider_root(provider);
                let marketplaces =
                    command_json(executable, ["plugin", "marketplace", "list", "--json"]).await?;
                ensure_marketplace_available(&marketplaces, &marketplace_root)?;
                if marketplace_entry(&marketplaces, MARKETPLACE_NAME).is_none() {
                    run_command(
                        executable,
                        [
                            OsString::from("plugin"),
                            OsString::from("marketplace"),
                            OsString::from("add"),
                            marketplace_root.into_os_string(),
                            OsString::from("--scope"),
                            OsString::from("user"),
                        ],
                    )
                    .await?;
                }
                let plugins = command_json(executable, ["plugin", "list", "--json"]).await?;
                if plugin_entry(&plugins, "id", PLUGIN_SELECTOR).is_some() {
                    run_command(
                        executable,
                        [
                            "plugin",
                            "uninstall",
                            PLUGIN_SELECTOR,
                            "--scope",
                            "user",
                            "--yes",
                        ],
                    )
                    .await?;
                }
                run_command(
                    executable,
                    ["plugin", "install", PLUGIN_SELECTOR, "--scope", "user"],
                )
                .await?;
            }
            AgentIntegrationProvider::Pi => {
                let package_root = self.provider_root(provider);
                let output = run_command(executable, ["list", "--no-approve"]).await?;
                if package_list_contains(&output.stdout, &package_root) {
                    run_command(
                        executable,
                        [
                            OsString::from("remove"),
                            package_root.clone().into_os_string(),
                            OsString::from("--no-approve"),
                        ],
                    )
                    .await?;
                }
                run_command(
                    executable,
                    [
                        OsString::from("install"),
                        package_root.into_os_string(),
                        OsString::from("--no-approve"),
                    ],
                )
                .await?;
            }
        }
        Ok(())
    }

    async fn remove(
        &self,
        provider: AgentIntegrationProvider,
        executable: &Path,
    ) -> Result<(), String> {
        match provider {
            AgentIntegrationProvider::Codex => {
                let marketplaces =
                    command_json(executable, ["plugin", "marketplace", "list", "--json"]).await?;
                let plugins = command_json(executable, ["plugin", "list", "--json"]).await?;
                if marketplace_allows_plugin_removal(
                    &marketplaces,
                    &self.provider_root(provider),
                    "root",
                ) && plugin_entry(&plugins, "pluginId", PLUGIN_SELECTOR).is_some()
                {
                    run_command(executable, ["plugin", "remove", PLUGIN_SELECTOR, "--json"])
                        .await?;
                }
                if marketplace_is_ours(&marketplaces, &self.provider_root(provider), "root") {
                    run_command(
                        executable,
                        ["plugin", "marketplace", "remove", MARKETPLACE_NAME],
                    )
                    .await?;
                }
            }
            AgentIntegrationProvider::Claude => {
                let marketplaces =
                    command_json(executable, ["plugin", "marketplace", "list", "--json"]).await?;
                let plugins = command_json(executable, ["plugin", "list", "--json"]).await?;
                if marketplace_allows_plugin_removal(
                    &marketplaces,
                    &self.provider_root(provider),
                    "installLocation",
                ) && plugin_entry(&plugins, "id", PLUGIN_SELECTOR).is_some()
                {
                    run_command(
                        executable,
                        [
                            "plugin",
                            "uninstall",
                            PLUGIN_SELECTOR,
                            "--scope",
                            "user",
                            "--yes",
                        ],
                    )
                    .await?;
                }
                if marketplace_is_ours(
                    &marketplaces,
                    &self.provider_root(provider),
                    "installLocation",
                ) {
                    run_command(
                        executable,
                        ["plugin", "marketplace", "remove", MARKETPLACE_NAME],
                    )
                    .await?;
                }
            }
            AgentIntegrationProvider::Pi => {
                let package_root = self.provider_root(provider);
                let output = run_command(executable, ["list", "--no-approve"]).await?;
                if package_list_contains(&output.stdout, &package_root) {
                    run_command(
                        executable,
                        [
                            OsString::from("remove"),
                            package_root.into_os_string(),
                            OsString::from("--no-approve"),
                        ],
                    )
                    .await?;
                }
            }
        }
        let root = self.provider_root(provider);
        if root.is_dir() {
            tokio::fs::remove_dir_all(&root)
                .await
                .map_err(|error| format!("unable to remove {}: {error}", root.display()))?;
        }
        Ok(())
    }

    async fn prepare_package(&self, provider: AgentIntegrationProvider) -> Result<(), String> {
        let root = self.provider_root(provider);
        match provider {
            AgentIntegrationProvider::Codex => {
                write_asset(
                    &root.join(format!("plugins/{PLUGIN_NAME}/.codex-plugin/plugin.json")),
                    CODEX_MANIFEST,
                )
                .await?;
                write_asset(
                    &root.join(format!("plugins/{PLUGIN_NAME}/hooks/hooks.json")),
                    CODEX_HOOKS,
                )
                .await?;
                write_json(
                    &root.join(".agents/plugins/marketplace.json"),
                    &codex_marketplace(),
                )
                .await?;
            }
            AgentIntegrationProvider::Claude => {
                write_asset(
                    &root.join(format!("plugins/{PLUGIN_NAME}/.claude-plugin/plugin.json")),
                    CLAUDE_MANIFEST,
                )
                .await?;
                write_asset(
                    &root.join(format!("plugins/{PLUGIN_NAME}/hooks/hooks.json")),
                    CLAUDE_HOOKS,
                )
                .await?;
                write_json(
                    &root.join(".claude-plugin/marketplace.json"),
                    &claude_marketplace(),
                )
                .await?;
            }
            AgentIntegrationProvider::Pi => {
                write_asset(&root.join("package.json"), PI_MANIFEST).await?;
                write_asset(
                    &root.join("extensions/term-server-agent-events.ts"),
                    PI_EXTENSION,
                )
                .await?;
            }
        }
        Ok(())
    }

    fn provider_root(&self, provider: AgentIntegrationProvider) -> PathBuf {
        self.root.join(match provider {
            AgentIntegrationProvider::Codex => "codex-marketplace",
            AgentIntegrationProvider::Claude => "claude-marketplace",
            AgentIntegrationProvider::Pi => "pi",
        })
    }

    fn assets_current(&self, provider: AgentIntegrationProvider) -> bool {
        let root = self.provider_root(provider);
        let assets: &[(&str, &str)] = match provider {
            AgentIntegrationProvider::Codex => &[
                (
                    "plugins/term-server-agent-events/.codex-plugin/plugin.json",
                    CODEX_MANIFEST,
                ),
                (
                    "plugins/term-server-agent-events/hooks/hooks.json",
                    CODEX_HOOKS,
                ),
            ],
            AgentIntegrationProvider::Claude => &[
                (
                    "plugins/term-server-agent-events/.claude-plugin/plugin.json",
                    CLAUDE_MANIFEST,
                ),
                (
                    "plugins/term-server-agent-events/hooks/hooks.json",
                    CLAUDE_HOOKS,
                ),
            ],
            AgentIntegrationProvider::Pi => &[
                ("package.json", PI_MANIFEST),
                ("extensions/term-server-agent-events.ts", PI_EXTENSION),
            ],
        };
        let assets_current = assets.iter().all(|(path, expected)| {
            std::fs::read_to_string(root.join(path)).is_ok_and(|content| content == *expected)
        });
        let marketplace_current = match provider {
            AgentIntegrationProvider::Codex => json_file_matches(
                &root.join(".agents/plugins/marketplace.json"),
                &codex_marketplace(),
            ),
            AgentIntegrationProvider::Claude => json_file_matches(
                &root.join(".claude-plugin/marketplace.json"),
                &claude_marketplace(),
            ),
            AgentIntegrationProvider::Pi => true,
        };
        assets_current && marketplace_current
    }
}

fn codex_marketplace() -> Value {
    serde_json::json!({
        "name": MARKETPLACE_NAME,
        "interface": { "displayName": "term-server local" },
        "plugins": [{
            "name": PLUGIN_NAME,
            "source": { "source": "local", "path": format!("./plugins/{PLUGIN_NAME}") },
            "policy": {
                "installation": "AVAILABLE",
                "authentication": "ON_INSTALL"
            },
            "category": "Productivity"
        }]
    })
}

fn claude_marketplace() -> Value {
    serde_json::json!({
        "name": MARKETPLACE_NAME,
        "description": "Local term-server integrations",
        "owner": { "name": "term-server" },
        "plugins": [{
            "name": PLUGIN_NAME,
            "description": "Reports Claude Code lifecycle activity to term-server.",
            "version": "0.1.0",
            "author": { "name": "term-server" },
            "source": format!("./plugins/{PLUGIN_NAME}")
        }]
    })
}

fn json_file_matches(path: &Path, expected: &Value) -> bool {
    std::fs::read(path)
        .ok()
        .and_then(|content| serde_json::from_slice::<Value>(&content).ok())
        .is_some_and(|actual| actual == *expected)
}

fn status(
    provider: AgentIntegrationProvider,
    state: AgentIntegrationState,
    message: String,
) -> AgentIntegrationStatus {
    AgentIntegrationStatus {
        provider,
        name: provider.label().to_owned(),
        state,
        message,
    }
}

fn classify_status(
    provider: AgentIntegrationProvider,
    registered: bool,
    collision: bool,
    installed: bool,
    enabled: bool,
    assets_current: bool,
) -> AgentIntegrationStatus {
    if collision {
        return status(
            provider,
            AgentIntegrationState::NeedsRepair,
            format!(
                "A different marketplace already uses the {MARKETPLACE_NAME} name; no configuration was changed."
            ),
        );
    }
    if !registered && !installed {
        return status(
            provider,
            AgentIntegrationState::NotInstalled,
            "Native events are off; process/output inference remains active.".to_owned(),
        );
    }
    if !registered || !installed || !enabled || !assets_current {
        return status(
            provider,
            AgentIntegrationState::NeedsRepair,
            "The managed package is missing, disabled, or out of date; process/output inference remains active."
                .to_owned(),
        );
    }
    let message = if provider == AgentIntegrationProvider::Codex {
        "Installed for new sessions. Codex will ask you to review this hook once in /hooks."
    } else {
        "Installed and active for new agent sessions."
    };
    status(
        provider,
        AgentIntegrationState::Installed,
        message.to_owned(),
    )
}

fn marketplace_entry<'a>(json: &'a Value, name: &str) -> Option<&'a Value> {
    json.as_array()
        .or_else(|| json.get("marketplaces").and_then(Value::as_array))
        .and_then(|entries| {
            entries
                .iter()
                .find(|entry| entry.get("name").and_then(Value::as_str) == Some(name))
        })
}

fn plugin_entry<'a>(json: &'a Value, field: &str, id: &str) -> Option<&'a Value> {
    json.as_array()
        .or_else(|| json.get("installed").and_then(Value::as_array))
        .and_then(|entries| {
            entries
                .iter()
                .find(|entry| entry.get(field).and_then(Value::as_str) == Some(id))
        })
}

fn ensure_marketplace_available(json: &Value, expected_root: &Path) -> Result<(), String> {
    let Some(entry) = marketplace_entry(json, MARKETPLACE_NAME) else {
        return Ok(());
    };
    let configured_root = entry
        .get("root")
        .or_else(|| entry.get("installLocation"))
        .and_then(Value::as_str)
        .map(Path::new);
    if configured_root.is_some_and(|root| paths_match(root, expected_root)) {
        Ok(())
    } else {
        Err(format!(
            "a different provider marketplace already uses the {MARKETPLACE_NAME} name"
        ))
    }
}

fn marketplace_is_ours(json: &Value, expected_root: &Path, root_field: &str) -> bool {
    marketplace_entry(json, MARKETPLACE_NAME)
        .and_then(|entry| entry.get(root_field))
        .and_then(Value::as_str)
        .is_some_and(|root| paths_match(Path::new(root), expected_root))
}

fn marketplace_allows_plugin_removal(json: &Value, expected_root: &Path, root_field: &str) -> bool {
    marketplace_entry(json, MARKETPLACE_NAME).is_none()
        || marketplace_is_ours(json, expected_root, root_field)
}

fn package_list_contains(output: &[u8], expected_root: &Path) -> bool {
    String::from_utf8_lossy(output)
        .lines()
        .map(str::trim)
        .any(|line| !line.is_empty() && paths_match(Path::new(line), expected_root))
}

fn paths_match(left: &Path, right: &Path) -> bool {
    let left = left.canonicalize().unwrap_or_else(|_| left.to_path_buf());
    let right = right.canonicalize().unwrap_or_else(|_| right.to_path_buf());
    left == right
}

async fn write_asset(path: &Path, content: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("invalid integration path: {}", path.display()))?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| format!("unable to create {}: {error}", parent.display()))?;
    tokio::fs::write(path, content)
        .await
        .map_err(|error| format!("unable to write {}: {error}", path.display()))
}

async fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let mut content = serde_json::to_string_pretty(value)
        .map_err(|error| format!("unable to encode integration manifest: {error}"))?;
    content.push('\n');
    write_asset(path, &content).await
}

async fn command_json<I, S>(executable: &Path, arguments: I) -> Result<Value, String>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let output = run_command(executable, arguments).await?;
    serde_json::from_slice(&output.stdout).map_err(|error| {
        format!(
            "{} returned invalid status data: {error}",
            executable.display()
        )
    })
}

async fn run_command<I, S>(executable: &Path, arguments: I) -> Result<Output, String>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let mut command = Command::new(executable);
    command
        .args(arguments.into_iter().map(Into::into))
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .env_remove("TERM_SERVER_SESSION")
        .env_remove("TERM_SERVER_EXECUTABLE")
        .env_remove("TERM_SERVER_BROKER_SOCKET");
    let output = tokio::time::timeout(COMMAND_TIMEOUT, command.output())
        .await
        .map_err(|_| format!("{} timed out", executable.display()))?
        .map_err(|error| format!("unable to run {}: {error}", executable.display()))?;
    if output.status.success() {
        Ok(output)
    } else {
        let error = String::from_utf8_lossy(&output.stderr);
        Err(format!(
            "{} failed{}",
            executable.display(),
            error
                .trim()
                .is_empty()
                .then(String::new)
                .unwrap_or_else(|| format!(": {}", error.trim()))
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_additive_installation_states() {
        assert_eq!(
            classify_status(
                AgentIntegrationProvider::Claude,
                false,
                false,
                false,
                false,
                false,
            )
            .state,
            AgentIntegrationState::NotInstalled
        );
        assert_eq!(
            classify_status(
                AgentIntegrationProvider::Claude,
                true,
                false,
                true,
                true,
                false,
            )
            .state,
            AgentIntegrationState::NeedsRepair
        );
        assert_eq!(
            classify_status(
                AgentIntegrationProvider::Claude,
                true,
                false,
                true,
                true,
                true,
            )
            .state,
            AgentIntegrationState::Installed
        );
    }

    #[test]
    fn detects_marketplace_name_collisions_without_claiming_them() {
        let json = serde_json::json!({
            "marketplaces": [{
                "name": MARKETPLACE_NAME,
                "root": "/someone/elses/marketplace"
            }]
        });
        assert!(ensure_marketplace_available(&json, Path::new("/our/marketplace")).is_err());
        assert!(!marketplace_is_ours(
            &json,
            Path::new("/our/marketplace"),
            "root"
        ));
        assert!(!marketplace_allows_plugin_removal(
            &json,
            Path::new("/our/marketplace"),
            "root"
        ));
        assert!(marketplace_allows_plugin_removal(
            &serde_json::json!([]),
            Path::new("/our/marketplace"),
            "root"
        ));
    }

    #[test]
    fn matches_pi_packages_by_exact_path() {
        let expected = Path::new("/tmp/term-server/agent-integrations/pi");
        let output = b"User packages:\n  /tmp/term-server/agent-integrations/pi-other\n  /tmp/term-server/agent-integrations/pi\n";
        assert!(package_list_contains(output, expected));
        assert!(!package_list_contains(
            b"User packages:\n  /tmp/term-server/agent-integrations/pi-other\n",
            expected
        ));
    }

    #[tokio::test]
    async fn writes_only_the_managed_provider_package() {
        let directory = tempfile::tempdir().unwrap();
        let service = AgentIntegrationService::new(directory.path());
        service
            .prepare_package(AgentIntegrationProvider::Codex)
            .await
            .unwrap();
        assert!(service.assets_current(AgentIntegrationProvider::Codex));
        assert!(
            service
                .provider_root(AgentIntegrationProvider::Codex)
                .join(".agents/plugins/marketplace.json")
                .is_file()
        );
        assert!(
            !service
                .provider_root(AgentIntegrationProvider::Claude)
                .exists()
        );
    }
}
