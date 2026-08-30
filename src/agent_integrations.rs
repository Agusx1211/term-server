use std::{
    collections::BTreeSet,
    env,
    ffi::OsString,
    path::{Path, PathBuf},
    process::{Output, Stdio},
    time::Duration,
};

use futures_util::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::process::Command;

use crate::ai::find_executable;

const MARKETPLACE_NAME: &str = "term-server-local";
const PLUGIN_NAME: &str = "term-server-agent-events";
const PLUGIN_SELECTOR: &str = "term-server-agent-events@term-server-local";
const COMMAND_TIMEOUT: Duration = Duration::from_secs(60);
const OMP_OWNERSHIP_MARKER_VERSION: u8 = 1;
const OMP_OWNERSHIP_MARKER_DIR: &str = ".term-server-profile-ownership";

const CODEX_MANIFEST: &str = include_str!("../integrations/codex/.codex-plugin/plugin.json");
const CODEX_HOOKS: &str = include_str!("../integrations/codex/hooks/hooks.json");
const CLAUDE_MANIFEST: &str = include_str!("../integrations/claude/.claude-plugin/plugin.json");
const CLAUDE_HOOKS: &str = include_str!("../integrations/claude/hooks/hooks.json");
const PI_MANIFEST: &str = include_str!("../integrations/pi/package.json");
const PI_EXTENSION: &str =
    include_str!("../integrations/pi/extensions/term-server-agent-events.ts");
const OMP_PACKAGE: &str = include_str!("../integrations/omp/package.json");
const OMP_EXTENSION: &str =
    include_str!("../integrations/omp/extensions/term-server-agent-events.ts");
const OMP_ACTIVITY: &str = include_str!("../integrations/omp/extensions/subagent-activity.ts");
const HERMES_PLUGIN_YAML: &str = include_str!("../integrations/hermes/plugin.yaml");
const HERMES_PLUGIN_INIT: &str = include_str!("../integrations/hermes/__init__.py");
const HERMES_HOME_ENV_VAR: &str = "HERMES_HOME";
const HERMES_PLUGIN_DIR_NAME: &str = "term-server-agent-events";

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentIntegrationProvider {
    Codex,
    Claude,
    Pi,
    Omp,
    Hermes,
}

impl AgentIntegrationProvider {
    fn command(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
            Self::Pi => "pi",
            Self::Omp => "omp",
            Self::Hermes => "hermes",
        }
    }

    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Codex => "Codex",
            Self::Claude => "Claude Code",
            Self::Pi => "Pi",
            Self::Omp => "OMP",
            Self::Hermes => "Hermes",
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
pub struct AgentIntegrationProfileStatus {
    pub id: String,
    pub label: String,
    pub state: AgentIntegrationState,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentIntegrationStatus {
    pub provider: AgentIntegrationProvider,
    pub name: String,
    pub state: AgentIntegrationState,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profiles: Option<Vec<AgentIntegrationProfileStatus>>,
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
    omp_config_root: Option<PathBuf>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
struct OmpProfile {
    id: String,
    label: String,
}

#[derive(Debug, Clone)]
struct OmpProfileInspection {
    source: Option<PathBuf>,
    plugins: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct OmpProfileOwnershipMarker {
    marker_version: u8,
    install_path: String,
    version: String,
    installed_at: String,
    last_updated_at: String,
}
impl AgentIntegrationService {
    pub fn new(data_directory: &Path) -> Self {
        Self {
            root: data_directory.join("agent-integrations"),
            omp_config_root: None,
        }
    }

    #[cfg(test)]
    fn new_with_omp_config_root(data_directory: &Path, omp_config_root: &Path) -> Self {
        Self {
            root: data_directory.join("agent-integrations"),
            omp_config_root: Some(omp_config_root.to_owned()),
        }
    }

    fn omp_profiles(&self) -> Vec<OmpProfile> {
        self.omp_config_root
            .as_deref()
            .map(discover_omp_profiles_from)
            .unwrap_or_else(discover_omp_profiles)
    }

    pub async fn status(&self) -> AgentIntegrationsConfig {
        let (codex, claude, pi, omp, hermes) = tokio::join!(
            self.provider_status(AgentIntegrationProvider::Codex),
            self.provider_status(AgentIntegrationProvider::Claude),
            self.provider_status(AgentIntegrationProvider::Pi),
            self.provider_status(AgentIntegrationProvider::Omp),
            self.provider_status(AgentIntegrationProvider::Hermes),
        );
        AgentIntegrationsConfig {
            providers: vec![codex, claude, pi, omp, hermes],
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
            AgentIntegrationProvider::Omp => self.omp_status(&executable).await,
            AgentIntegrationProvider::Hermes => self.hermes_status().await,
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
        let (marketplaces, plugins) = tokio::try_join!(
            command_json(executable, ["plugin", "marketplace", "list", "--json"]),
            command_json(executable, ["plugin", "list", "--json"]),
        )?;
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
        let (marketplaces, plugins) = tokio::try_join!(
            command_json(executable, ["plugin", "marketplace", "list", "--json"]),
            command_json(executable, ["plugin", "list", "--json"]),
        )?;
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

    async fn omp_status(&self, executable: &Path) -> Result<AgentIntegrationStatus, String> {
        let profiles = self.omp_profiles();
        let source_root = self.provider_root(AgentIntegrationProvider::Omp);
        let source_root = &source_root;
        let assets_current = self.assets_current(AgentIntegrationProvider::Omp);
        let profile_statuses = stream::iter(profiles)
            .map(|profile| async move {
                match self.inspect_omp_profile(executable, &profile).await {
                    Ok(inspection) => {
                        let plugin = omp_plugin_entry(&inspection.plugins, PLUGIN_SELECTOR);
                        let registered = inspection
                            .source
                            .as_ref()
                            .is_some_and(|source| paths_match(source, source_root));
                        let collision = inspection.source.is_some() && !registered;
                        let installed = plugin.is_some();
                        let enabled = plugin.is_some_and(omp_plugin_enabled);
                        let plugin_assets_current = plugin.is_some_and(omp_plugin_assets_current);
                        classify_omp_profile_status(
                            &profile,
                            collision,
                            registered,
                            installed,
                            enabled,
                            assets_current && plugin_assets_current,
                        )
                    }
                    Err(_) => omp_profile_status(
                        &profile,
                        AgentIntegrationState::NeedsRepair,
                        "Unable to inspect this OMP profile; process/output inference remains active.",
                    ),
                }
            })
            .buffered(4)
            .collect()
            .await;
        Ok(aggregate_omp_status(profile_statuses))
    }

    async fn hermes_status(&self) -> Result<AgentIntegrationStatus, String> {
        let plugin_dir = hermes_plugin_dir();
        let installed = plugin_dir
            .as_deref()
            .is_some_and(hermes_plugin_files_present);
        let assets_current = plugin_dir
            .as_deref()
            .is_some_and(hermes_plugin_assets_current);
        let enabled = hermes_plugin_enabled();
        Ok(classify_status(
            AgentIntegrationProvider::Hermes,
            installed,
            false,
            installed,
            enabled,
            assets_current,
        ))
    }

    async fn inspect_omp_profile(
        &self,
        executable: &Path,
        profile: &OmpProfile,
    ) -> Result<OmpProfileInspection, String> {
        let (source, plugins) = tokio::try_join!(
            omp_marketplace_source(executable, profile),
            command_json(
                executable,
                omp_profile_args(profile, ["plugin", "list", "--json"]),
            ),
        )?;
        Ok(OmpProfileInspection { source, plugins })
    }
    async fn install_omp_profile(
        &self,
        executable: &Path,
        profile: &OmpProfile,
    ) -> Result<(), String> {
        let inspection = self.inspect_omp_profile(executable, profile).await?;
        let marketplace_root = self.provider_root(AgentIntegrationProvider::Omp);
        let registered = inspection
            .source
            .as_ref()
            .is_some_and(|source| paths_match(source, &marketplace_root));
        if inspection.source.is_some() && !registered {
            return Err(omp_marketplace_collision_error(profile));
        }
        let plugin = omp_plugin_entry(&inspection.plugins, PLUGIN_SELECTOR);
        let needs_install = omp_plugin_needs_install(inspection.source.is_some(), plugin);
        let marker_current = omp_profile_marker_current(&marketplace_root, profile, plugin);
        let uninstall_user_plugin = needs_install
            && omp_user_plugin_should_uninstall(
                profile,
                inspection.source.as_deref(),
                &marketplace_root,
                marker_current,
                plugin.is_some_and(omp_plugin_user_owned),
            )?;
        if !registered {
            run_command(
                executable,
                omp_profile_args(
                    profile,
                    [
                        OsString::from("plugin"),
                        OsString::from("marketplace"),
                        OsString::from("add"),
                        marketplace_root.clone().into_os_string(),
                    ],
                ),
            )
            .await?;
        }
        if needs_install {
            if uninstall_user_plugin {
                run_command(
                    executable,
                    omp_profile_args(
                        profile,
                        ["plugin", "uninstall", PLUGIN_SELECTOR, "--scope", "user"],
                    ),
                )
                .await?;
            }
            run_command(
                executable,
                omp_profile_args(
                    profile,
                    ["plugin", "install", PLUGIN_SELECTOR, "--scope", "user"],
                ),
            )
            .await?;
        }

        let final_inspection = self.inspect_omp_profile(executable, profile).await?;
        let final_source_is_ours = final_inspection
            .source
            .as_ref()
            .is_some_and(|source| paths_match(source, &marketplace_root));
        let final_plugin = omp_plugin_entry(&final_inspection.plugins, PLUGIN_SELECTOR);
        let final_plugin_current = final_plugin.is_some_and(|plugin| {
            omp_plugin_enabled(plugin)
                && omp_plugin_assets_current(plugin)
                && omp_plugin_user_owned(plugin)
        });
        if !final_source_is_ours || !final_plugin_current {
            return Err(format!(
                "OMP profile '{}' did not reach the current managed extension state",
                profile.label
            ));
        }
        let Some(final_plugin) = final_plugin else {
            return Err(format!(
                "OMP profile '{}' did not expose its installed user entry",
                profile.label
            ));
        };
        self.mark_omp_profile_owned(profile, final_plugin).await
    }

    async fn mark_omp_profile_owned(
        &self,
        profile: &OmpProfile,
        plugin: &Value,
    ) -> Result<(), String> {
        let Some(marker) = omp_profile_ownership_marker_value(plugin) else {
            return Ok(());
        };
        let root = self.provider_root(AgentIntegrationProvider::Omp);
        let value = serde_json::to_value(marker)
            .map_err(|error| format!("unable to encode OMP profile ownership: {error}"))?;
        write_json(&omp_profile_ownership_marker(&root, profile), &value).await
    }

    async fn install(
        &self,
        provider: AgentIntegrationProvider,
        executable: &Path,
    ) -> Result<(), String> {
        if provider != AgentIntegrationProvider::Omp {
            self.prepare_package(provider).await?;
        }
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
            AgentIntegrationProvider::Omp => {
                let profiles = self.omp_profiles();
                self.prepare_package(provider).await?;
                let mut failed = false;
                for profile in &profiles {
                    if self.install_omp_profile(executable, profile).await.is_err() {
                        failed = true;
                    }
                }
                if failed {
                    return Err("unable to update one or more OMP profiles".to_owned());
                }
            }
            AgentIntegrationProvider::Hermes => {
                // Hermes discovers plugins from its plugins directory with no
                // CLI command, so "install" writes the plugin there and adds
                // it to the config allow-list.
                let plugin_dir = hermes_plugin_dir().ok_or_else(|| {
                    "unable to locate the Hermes config directory (set HERMES_HOME or ~/.hermes)"
                        .to_owned()
                })?;
                write_asset(&plugin_dir.join("plugin.yaml"), HERMES_PLUGIN_YAML).await?;
                write_asset(&plugin_dir.join("__init__.py"), HERMES_PLUGIN_INIT).await?;
                if let Some(config_path) = hermes_config_path() {
                    let existing = tokio::fs::read_to_string(&config_path)
                        .await
                        .unwrap_or_default();
                    let updated = ensure_hermes_plugin_enabled(&existing);
                    if updated != existing {
                        write_asset(&config_path, &updated).await?;
                    }
                }
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
            AgentIntegrationProvider::Omp => {
                let marketplace_root = self.provider_root(provider);
                let mut failed = false;
                for profile in self.omp_profiles() {
                    let Ok(inspection) = self.inspect_omp_profile(executable, &profile).await
                    else {
                        failed = true;
                        continue;
                    };
                    let ours = inspection
                        .source
                        .as_ref()
                        .is_some_and(|source| paths_match(source, &marketplace_root));
                    let plugin = omp_plugin_entry(&inspection.plugins, PLUGIN_SELECTOR);
                    let marker_current =
                        omp_profile_marker_current(&marketplace_root, &profile, plugin);
                    let owns_plugin = omp_profile_owns_plugin(
                        inspection.source.as_deref(),
                        &marketplace_root,
                        marker_current,
                    );
                    let managed_plugin =
                        plugin.is_some_and(|plugin| omp_plugin_user_owned(plugin) && owns_plugin);
                    if managed_plugin
                        && run_command(
                            executable,
                            omp_profile_args(
                                &profile,
                                ["plugin", "uninstall", PLUGIN_SELECTOR, "--scope", "user"],
                            ),
                        )
                        .await
                        .is_err()
                    {
                        failed = true;
                        continue;
                    }
                    if !ours {
                        continue;
                    }
                    if run_command(
                        executable,
                        omp_profile_args(
                            &profile,
                            ["plugin", "marketplace", "remove", MARKETPLACE_NAME],
                        ),
                    )
                    .await
                    .is_err()
                    {
                        failed = true;
                    }
                }
                if failed {
                    return Err("unable to remove one or more OMP profiles".to_owned());
                }
            }
            AgentIntegrationProvider::Hermes => {
                if let Some(plugin_dir) = hermes_plugin_dir() {
                    for name in ["plugin.yaml", "__init__.py"] {
                        let _ = tokio::fs::remove_file(plugin_dir.join(name)).await;
                    }
                    let _ = tokio::fs::remove_dir(plugin_dir).await;
                }
                if let Some(config_path) = hermes_config_path()
                    && let Ok(existing) = tokio::fs::read_to_string(&config_path).await
                {
                    let updated = remove_hermes_plugin_enabled(&existing);
                    if updated != existing {
                        let _ = write_asset(&config_path, &updated).await;
                    }
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
            AgentIntegrationProvider::Omp => {
                write_asset(
                    &root.join(format!("plugins/{PLUGIN_NAME}/package.json")),
                    OMP_PACKAGE,
                )
                .await?;
                write_asset(
                    &root.join(format!(
                        "plugins/{PLUGIN_NAME}/extensions/term-server-agent-events.ts"
                    )),
                    OMP_EXTENSION,
                )
                .await?;
                write_asset(
                    &root.join(format!(
                        "plugins/{PLUGIN_NAME}/extensions/subagent-activity.ts"
                    )),
                    OMP_ACTIVITY,
                )
                .await?;
                write_json(
                    &root.join(".omp-plugin/marketplace.json"),
                    &omp_marketplace(),
                )
                .await?;
            }
            AgentIntegrationProvider::Hermes => {
                write_asset(&root.join("plugin.yaml"), HERMES_PLUGIN_YAML).await?;
                write_asset(&root.join("__init__.py"), HERMES_PLUGIN_INIT).await?;
            }
        }
        Ok(())
    }

    fn provider_root(&self, provider: AgentIntegrationProvider) -> PathBuf {
        self.root.join(match provider {
            AgentIntegrationProvider::Codex => "codex-marketplace",
            AgentIntegrationProvider::Claude => "claude-marketplace",
            AgentIntegrationProvider::Pi => "pi",
            AgentIntegrationProvider::Omp => "omp-marketplace",
            AgentIntegrationProvider::Hermes => "hermes",
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
            AgentIntegrationProvider::Omp => &[
                ("plugins/term-server-agent-events/package.json", OMP_PACKAGE),
                (
                    "plugins/term-server-agent-events/extensions/term-server-agent-events.ts",
                    OMP_EXTENSION,
                ),
                (
                    "plugins/term-server-agent-events/extensions/subagent-activity.ts",
                    OMP_ACTIVITY,
                ),
            ],
            AgentIntegrationProvider::Hermes => &[
                ("plugin.yaml", HERMES_PLUGIN_YAML),
                ("__init__.py", HERMES_PLUGIN_INIT),
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
            AgentIntegrationProvider::Omp => json_file_matches(
                &root.join(".omp-plugin/marketplace.json"),
                &omp_marketplace(),
            ),
            AgentIntegrationProvider::Hermes => true,
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
            "description": "Reports Claude Code lifecycle and retained semantic history to term-server.",
            "version": "0.1.0",
            "author": { "name": "term-server" },
            "source": format!("./plugins/{PLUGIN_NAME}")
        }]
    })
}

fn omp_marketplace() -> Value {
    serde_json::json!({
        "name": MARKETPLACE_NAME,
        "owner": { "name": "term-server" },
        "plugins": [{
            "name": PLUGIN_NAME,
            "description": "Reports OMP lifecycle and retained semantic history to term-server.",
            "source": format!("./plugins/{PLUGIN_NAME}")
        }]
    })
}

fn omp_config_root() -> PathBuf {
    let home = env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let config_dir = env::var_os("PI_CONFIG_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(".omp"));
    home.join(config_dir)
}

fn omp_reserved_profile_name(name: &str) -> bool {
    let basename = name.split('.').next().unwrap_or(name);
    matches!(basename, "con" | "prn" | "aux" | "nul")
        || (basename.len() == 4
            && (basename.starts_with("com") || basename.starts_with("lpt"))
            && basename.as_bytes()[3].is_ascii_digit())
}

fn valid_omp_profile_name(name: &str) -> bool {
    let mut characters = name.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    let first_valid = first.is_ascii_lowercase() || first.is_ascii_digit();
    name.len() <= 64
        && first_valid
        && characters.all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '.' | '_' | '-')
        })
        && name != "."
        && name != ".."
        && !name.ends_with('.')
        && !omp_reserved_profile_name(name)
}

// ---------------------------------------------------------------------------
// Hermes
// ---------------------------------------------------------------------------

/// Hermes config root: `$HERMES_HOME`, else `~/.hermes`.
fn hermes_dir() -> Option<PathBuf> {
    if let Some(value) = env::var_os(HERMES_HOME_ENV_VAR).filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(value));
    }
    env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".hermes"))
}

fn hermes_plugin_dir() -> Option<PathBuf> {
    hermes_dir().map(|dir| dir.join("plugins").join(HERMES_PLUGIN_DIR_NAME))
}

fn hermes_config_path() -> Option<PathBuf> {
    hermes_dir().map(|dir| dir.join("config.yaml"))
}

fn hermes_plugin_files_present(dir: &Path) -> bool {
    dir.join("plugin.yaml").is_file() && dir.join("__init__.py").is_file()
}

fn hermes_plugin_assets_current(dir: &Path) -> bool {
    std::fs::read_to_string(dir.join("plugin.yaml"))
        .is_ok_and(|content| content == HERMES_PLUGIN_YAML)
        && std::fs::read_to_string(dir.join("__init__.py"))
            .is_ok_and(|content| content == HERMES_PLUGIN_INIT)
}

/// Whether `term-server-agent-events` is in the `plugins.enabled` allow-list of
/// the Hermes `config.yaml`. Mirrors the shapes `update_hermes_enabled_plugin`
/// edits, so status agrees with what an install/remove would produce.
fn hermes_plugin_enabled() -> bool {
    let Some(config_path) = hermes_config_path() else {
        return false;
    };
    let Ok(content) = std::fs::read_to_string(config_path) else {
        return false;
    };
    hermes_enabled_plugins_contain(&content, HERMES_PLUGIN_DIR_NAME)
}

fn hermes_enabled_plugins_contain(content: &str, name: &str) -> bool {
    let lines: Vec<String> = content.lines().map(str::to_string).collect();
    let Some(plugins_index) = top_level_yaml_key_index(&lines, "plugins") else {
        return false;
    };
    let plugins_end =
        next_top_level_yaml_key_index(&lines, plugins_index + 1).unwrap_or(lines.len());

    let enabled_index = lines[plugins_index + 1..plugins_end]
        .iter()
        .position(|line| yaml_key_at_indent(line, 2) == Some("enabled"))
        .map(|offset| plugins_index + 1 + offset);
    if let Some(enabled_index) = enabled_index {
        let line = lines[enabled_index].trim();
        if line == "enabled: []" || line == "enabled: [] # herdr" {
            return false;
        }
        let list_start = enabled_index + 1;
        let list_end = lines[list_start..plugins_end]
            .iter()
            .position(|line| {
                yaml_indent(line).is_some_and(|indent| indent <= 2) && yaml_key_name(line).is_some()
            })
            .map(|offset| list_start + offset)
            .unwrap_or(plugins_end);
        return lines[list_start..list_end]
            .iter()
            .any(|line| yaml_list_item_matches(line, name));
    }

    if let Some(items) = yaml_key_value_at_indent(&lines[plugins_index], 0, "plugins")
        .and_then(yaml_flow_sequence_items)
    {
        return items.iter().any(|item| item == name);
    }

    let flat_list_start = lines[plugins_index + 1..plugins_end]
        .iter()
        .position(|line| yaml_list_item_value_at_indent(line, 2).is_some())
        .map(|offset| plugins_index + 1 + offset);
    if let Some(flat_list_start) = flat_list_start {
        let list_end = lines[flat_list_start..plugins_end]
            .iter()
            .position(|line| yaml_indent(line).is_some_and(|indent| indent != 2))
            .map(|offset| flat_list_start + offset)
            .unwrap_or(plugins_end);
        return lines[flat_list_start..list_end]
            .iter()
            .any(|line| yaml_list_item_matches_at_indent(line, 2, name));
    }

    false
}

fn ensure_hermes_plugin_enabled(content: &str) -> String {
    update_hermes_enabled_plugin(content, true)
}

fn remove_hermes_plugin_enabled(content: &str) -> String {
    update_hermes_enabled_plugin(content, false)
}

/// Adds or removes `HERMES_PLUGIN_DIR_NAME` from the `plugins.enabled`
/// allow-list in a Hermes `config.yaml`, preserving unrelated keys and the
/// existing formatting. Ported from herdr's
/// `src/integration/config_edit.rs::update_hermes_enabled_plugin`.
fn update_hermes_enabled_plugin(content: &str, enabled: bool) -> String {
    let trailing_newline = content.ends_with('\n');
    let mut lines: Vec<String> = content.lines().map(str::to_string).collect();
    let Some(plugins_index) = top_level_yaml_key_index(&lines, "plugins") else {
        if !enabled {
            return content.to_string();
        }
        let mut result = content.trim_end_matches('\n').to_string();
        if !result.is_empty() {
            result.push('\n');
        }
        result.push_str("plugins:\n  enabled:\n    - term-server-agent-events\n");
        return result;
    };

    let plugins_end =
        next_top_level_yaml_key_index(&lines, plugins_index + 1).unwrap_or(lines.len());
    let plugins_inline_items = yaml_key_value_at_indent(&lines[plugins_index], 0, "plugins")
        .and_then(yaml_flow_sequence_items);
    let enabled_index = lines[plugins_index + 1..plugins_end]
        .iter()
        .position(|line| yaml_key_at_indent(line, 2) == Some("enabled"))
        .map(|offset| plugins_index + 1 + offset);
    let flat_list_start = lines[plugins_index + 1..plugins_end]
        .iter()
        .position(|line| yaml_list_item_value_at_indent(line, 2).is_some())
        .map(|offset| plugins_index + 1 + offset);

    if let Some(enabled_index) = enabled_index {
        let line = lines[enabled_index].trim();
        if line == "enabled: []" || line == "enabled: [] # herdr" {
            if enabled {
                lines[enabled_index] = "  enabled:".to_string();
                lines.insert(
                    enabled_index + 1,
                    "    - term-server-agent-events".to_string(),
                );
            }
            return join_yaml_lines(lines, trailing_newline);
        }

        let list_start = enabled_index + 1;
        let list_end = lines[list_start..plugins_end]
            .iter()
            .position(|line| {
                yaml_indent(line).is_some_and(|indent| indent <= 2) && yaml_key_name(line).is_some()
            })
            .map(|offset| list_start + offset)
            .unwrap_or(plugins_end);
        let existing_item_index = lines[list_start..list_end]
            .iter()
            .position(|line| yaml_list_item_matches(line, HERMES_PLUGIN_DIR_NAME))
            .map(|offset| list_start + offset);

        match (enabled, existing_item_index) {
            (true, Some(_)) | (false, None) => return content.to_string(),
            (true, None) => lines.insert(list_start, "    - term-server-agent-events".to_string()),
            (false, Some(index)) => {
                lines.remove(index);
            }
        }
        return join_yaml_lines(lines, trailing_newline);
    }

    if let Some(mut items) = plugins_inline_items {
        let existing_item_index = items.iter().position(|item| item == HERMES_PLUGIN_DIR_NAME);

        match (enabled, existing_item_index) {
            (true, Some(_)) | (false, None) => return content.to_string(),
            (true, None) => items.insert(0, HERMES_PLUGIN_DIR_NAME.to_string()),
            (false, Some(index)) => {
                items.remove(index);
            }
        }

        let replacement = hermes_flat_plugin_lines(&items);
        lines.splice(plugins_index..plugins_end, replacement);
        return join_yaml_lines(lines, trailing_newline);
    }

    if let Some(flat_list_start) = flat_list_start {
        let existing_item_index = lines[plugins_index + 1..plugins_end]
            .iter()
            .position(|line| yaml_list_item_matches_at_indent(line, 2, HERMES_PLUGIN_DIR_NAME))
            .map(|offset| plugins_index + 1 + offset);

        match (enabled, existing_item_index) {
            (true, Some(_)) | (false, None) => return content.to_string(),
            (true, None) => {
                lines.insert(flat_list_start, "  - term-server-agent-events".to_string())
            }
            (false, Some(index)) => {
                lines.remove(index);
            }
        }
        return join_yaml_lines(lines, trailing_newline);
    }

    if enabled {
        lines.insert(plugins_index + 1, "  enabled:".to_string());
        lines.insert(
            plugins_index + 2,
            "    - term-server-agent-events".to_string(),
        );
        return join_yaml_lines(lines, trailing_newline);
    }

    content.to_string()
}

fn hermes_flat_plugin_lines(items: &[String]) -> Vec<String> {
    if items.is_empty() {
        return vec!["plugins: []".to_string()];
    }
    let mut lines = vec!["plugins:".to_string()];
    lines.extend(items.iter().map(|item| format!("  - {item}")));
    lines
}

// ---------------------------------------------------------------------------
// YAML helpers (ported from herdr's src/integration/config_edit.rs)
// ---------------------------------------------------------------------------

fn top_level_yaml_key_index(lines: &[String], key: &str) -> Option<usize> {
    lines
        .iter()
        .position(|line| yaml_key_at_indent(line, 0) == Some(key))
}

fn next_top_level_yaml_key_index(lines: &[String], start: usize) -> Option<usize> {
    lines[start..]
        .iter()
        .position(|line| yaml_indent(line) == Some(0) && yaml_key_name(line).is_some())
        .map(|offset| start + offset)
}

fn yaml_key_at_indent(line: &str, indent: usize) -> Option<&str> {
    (yaml_indent(line)? == indent)
        .then(|| yaml_key_name(line))
        .flatten()
}

fn yaml_key_value_at_indent<'a>(line: &'a str, indent: usize, key: &str) -> Option<&'a str> {
    if yaml_indent(line)? != indent {
        return None;
    }
    let trimmed = line.trim_start();
    if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('-') {
        return None;
    }
    let (line_key, value) = trimmed.split_once(':')?;
    (line_key.trim() == key).then_some(value.trim())
}

fn yaml_key_name(line: &str) -> Option<&str> {
    let trimmed = line.trim_start();
    if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('-') {
        return None;
    }
    let (key, _) = trimmed.split_once(':')?;
    let key = key.trim();
    (!key.is_empty()).then_some(key)
}

fn yaml_indent(line: &str) -> Option<usize> {
    let trimmed = line.trim_start();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }
    Some(line.len() - trimmed.len())
}

fn yaml_list_item_value(line: &str) -> Option<&str> {
    line.trim().strip_prefix("- ").map(str::trim)
}

fn yaml_list_item_matches(line: &str, value: &str) -> bool {
    yaml_list_item_value(line).is_some_and(|item| yaml_scalar_value(item) == value)
}

fn yaml_list_item_value_at_indent(line: &str, indent: usize) -> Option<&str> {
    (yaml_indent(line)? == indent)
        .then(|| yaml_list_item_value(line))
        .flatten()
}

fn yaml_list_item_matches_at_indent(line: &str, indent: usize, value: &str) -> bool {
    yaml_list_item_value_at_indent(line, indent)
        .is_some_and(|item| yaml_scalar_value(item) == value)
}

fn yaml_flow_sequence_items(value: &str) -> Option<Vec<String>> {
    let value = strip_yaml_inline_comment(value).trim();
    let inner = value.strip_prefix('[')?.strip_suffix(']')?.trim();
    if inner.is_empty() {
        return Some(Vec::new());
    }

    let mut items = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut escaped = false;

    for ch in inner.chars() {
        if let Some(quote_char) = quote {
            current.push(ch);
            if quote_char == '"' && ch == '\\' && !escaped {
                escaped = true;
                continue;
            }
            if ch == quote_char && !escaped {
                quote = None;
            }
            escaped = false;
            continue;
        }

        match ch {
            '"' | '\'' => {
                quote = Some(ch);
                current.push(ch);
            }
            ',' => {
                items.push(yaml_scalar_value(&current));
                current.clear();
            }
            _ => current.push(ch),
        }
    }

    if quote.is_some() {
        return None;
    }

    items.push(yaml_scalar_value(&current));
    Some(items)
}

fn yaml_scalar_value(value: &str) -> String {
    let value = strip_yaml_inline_comment(value).trim();
    if value.len() >= 2 {
        let bytes = value.as_bytes();
        let quoted = (bytes[0] == b'"' && bytes[value.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[value.len() - 1] == b'\'');
        if quoted {
            return value[1..value.len() - 1].to_string();
        }
    }
    value.to_string()
}

fn strip_yaml_inline_comment(value: &str) -> &str {
    let mut quote = None;
    let mut escaped = false;

    for (index, ch) in value.char_indices() {
        if let Some(quote_char) = quote {
            if quote_char == '"' && ch == '\\' && !escaped {
                escaped = true;
                continue;
            }
            if ch == quote_char && !escaped {
                quote = None;
            }
            escaped = false;
            continue;
        }

        match ch {
            '"' | '\'' => quote = Some(ch),
            '#' if index == 0 || value[..index].ends_with(char::is_whitespace) => {
                return value[..index].trim_end();
            }
            _ => {}
        }
    }

    value
}

fn join_yaml_lines(lines: Vec<String>, trailing_newline: bool) -> String {
    let mut result = lines.join("\n");
    if trailing_newline || result.is_empty() {
        result.push('\n');
    }
    result
}

fn discover_omp_profiles() -> Vec<OmpProfile> {
    let mut names = BTreeSet::from(["default".to_owned()]);
    let config_root = omp_config_root();
    add_omp_profile_names(&config_root, &mut names);
    for variable in ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"] {
        if let Some(root) = env::var_os(variable) {
            add_omp_profile_names(&PathBuf::from(root).join("omp"), &mut names);
        }
    }
    omp_profiles_from_names(names)
}

fn discover_omp_profiles_from(config_root: &Path) -> Vec<OmpProfile> {
    let mut names = BTreeSet::from(["default".to_owned()]);
    add_omp_profile_names(config_root, &mut names);
    omp_profiles_from_names(names)
}

fn add_omp_profile_names(config_root: &Path, names: &mut BTreeSet<String>) {
    let profiles_root = config_root.join("profiles");
    let Ok(entries) = std::fs::read_dir(profiles_root) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if file_type.is_dir() && name != "default" && valid_omp_profile_name(&name) {
            names.insert(name.into_owned());
        }
    }
}
fn omp_profiles_from_names(names: BTreeSet<String>) -> Vec<OmpProfile> {
    names
        .into_iter()
        .map(|id| OmpProfile {
            label: if id == "default" {
                "Default".to_owned()
            } else {
                id.clone()
            },
            id,
        })
        .collect()
}
fn omp_profile_args<I, S>(profile: &OmpProfile, arguments: I) -> Vec<OsString>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let mut args = vec![
        OsString::from("--profile"),
        OsString::from(profile.id.as_str()),
    ];
    args.extend(arguments.into_iter().map(Into::into));
    args
}

/// `omp plugin marketplace list` does not emit JSON, so parse the human listing
/// to recover the registered source directory for our marketplace name, if any.
fn parse_omp_marketplace_source(output: &[u8]) -> Option<PathBuf> {
    String::from_utf8_lossy(output).lines().find_map(|line| {
        let trimmed = line.trim();
        let rest = trimmed.strip_prefix(MARKETPLACE_NAME)?;
        if !rest.is_empty() && !rest.starts_with(char::is_whitespace) {
            return None;
        }
        let source = PathBuf::from(rest.trim());
        (!source.as_os_str().is_empty()).then_some(source)
    })
}

async fn omp_marketplace_source(
    executable: &Path,
    profile: &OmpProfile,
) -> Result<Option<PathBuf>, String> {
    let output = run_command(
        executable,
        omp_profile_args(profile, ["plugin", "marketplace", "list"]),
    )
    .await?;
    Ok(parse_omp_marketplace_source(&output.stdout))
}

fn omp_marketplace_collision_error(profile: &OmpProfile) -> String {
    format!(
        "OMP profile '{}' uses a different marketplace named '{}'",
        profile.label, MARKETPLACE_NAME
    )
}

fn omp_profile_ownership_marker(root: &Path, profile: &OmpProfile) -> PathBuf {
    root.join(OMP_OWNERSHIP_MARKER_DIR)
        .join(format!("{}.marker", profile.id))
}

fn omp_profile_ownership_marker_value(entry: &Value) -> Option<OmpProfileOwnershipMarker> {
    let entry = omp_plugin_user_entry(entry)?;
    let install_path = entry.get("installPath")?.as_str()?.to_owned();
    let version = entry.get("version")?.as_str()?.to_owned();
    let installed_at = entry.get("installedAt")?.as_str()?.to_owned();
    let last_updated_at = entry
        .get("lastUpdatedAt")
        .or_else(|| entry.get("lastUpdated"))?
        .as_str()?
        .to_owned();
    if install_path.is_empty()
        || version.is_empty()
        || installed_at.is_empty()
        || last_updated_at.is_empty()
    {
        return None;
    }
    Some(OmpProfileOwnershipMarker {
        marker_version: OMP_OWNERSHIP_MARKER_VERSION,
        install_path,
        version,
        installed_at,
        last_updated_at,
    })
}

fn omp_profile_marker_current(root: &Path, profile: &OmpProfile, plugin: Option<&Value>) -> bool {
    let Some(plugin) = plugin else {
        return false;
    };
    if !omp_plugin_user_owned(plugin) || !omp_plugin_assets_current(plugin) {
        return false;
    }
    let Some(expected) = omp_profile_ownership_marker_value(plugin) else {
        return false;
    };
    std::fs::read(omp_profile_ownership_marker(root, profile))
        .ok()
        .and_then(|content| serde_json::from_slice::<OmpProfileOwnershipMarker>(&content).ok())
        .is_some_and(|actual| actual == expected)
}

fn omp_profile_owns_plugin(
    source: Option<&Path>,
    marketplace_root: &Path,
    marker_current: bool,
) -> bool {
    source.is_some_and(|source| paths_match(source, marketplace_root))
        || (source.is_none() && marker_current)
}

fn omp_unowned_user_plugin_error(profile: &OmpProfile) -> String {
    format!(
        "OMP profile '{}' has an existing unowned user plugin; term-server will not replace it",
        profile.label
    )
}

fn omp_user_plugin_should_uninstall(
    profile: &OmpProfile,
    source: Option<&Path>,
    marketplace_root: &Path,
    marker_current: bool,
    user_owned: bool,
) -> Result<bool, String> {
    if !user_owned {
        return Ok(false);
    }
    if omp_profile_owns_plugin(source, marketplace_root, marker_current) {
        Ok(true)
    } else {
        Err(omp_unowned_user_plugin_error(profile))
    }
}

fn omp_plugin_entry<'a>(plugins: &'a Value, id: &str) -> Option<&'a Value> {
    let entries = plugins
        .get("marketplace")
        .and_then(Value::as_array)
        .or_else(|| plugins.as_array())
        .or_else(|| plugins.get("installed").and_then(Value::as_array))?;
    entries
        .iter()
        .filter(|entry| {
            entry
                .get("id")
                .or_else(|| entry.get("pluginId"))
                .and_then(Value::as_str)
                == Some(id)
        })
        .find(|entry| {
            entry.get("scope").and_then(Value::as_str) == Some("user")
                || entry
                    .get("entries")
                    .and_then(Value::as_array)
                    .is_some_and(|entries| {
                        entries
                            .iter()
                            .any(|entry| entry.get("scope").and_then(Value::as_str) == Some("user"))
                    })
        })
        .or_else(|| {
            entries.iter().find(|entry| {
                entry
                    .get("id")
                    .or_else(|| entry.get("pluginId"))
                    .and_then(Value::as_str)
                    == Some(id)
            })
        })
}

fn omp_plugin_user_entry(entry: &Value) -> Option<&Value> {
    if entry.get("scope").and_then(Value::as_str) == Some("project") {
        return None;
    }
    let Some(entries) = entry.get("entries").and_then(Value::as_array) else {
        return Some(entry);
    };
    entries
        .iter()
        .find(|candidate| candidate.get("scope").and_then(Value::as_str) == Some("user"))
        .or_else(|| {
            entries
                .iter()
                .find(|candidate| candidate.get("scope").and_then(Value::as_str) != Some("project"))
        })
}

fn omp_plugin_user_owned(entry: &Value) -> bool {
    omp_plugin_user_entry(entry).is_some()
}

fn omp_plugin_enabled(entry: &Value) -> bool {
    let entry = omp_plugin_user_entry(entry).unwrap_or(entry);
    entry
        .get("enabled")
        .and_then(Value::as_bool)
        .or_else(|| {
            entry
                .get("entries")
                .and_then(Value::as_array)
                .and_then(|entries| entries.first())
                .and_then(|entry| entry.get("enabled"))
                .and_then(Value::as_bool)
        })
        .unwrap_or(true)
}

fn omp_plugin_needs_install(source_registered: bool, plugin: Option<&Value>) -> bool {
    let Some(plugin) = plugin else {
        return true;
    };
    !source_registered || !omp_plugin_enabled(plugin) || !omp_plugin_assets_current(plugin)
}

fn omp_plugin_assets_current(entry: &Value) -> bool {
    let entry = omp_plugin_user_entry(entry).unwrap_or(entry);
    let Some(root) = entry
        .get("installPath")
        .and_then(Value::as_str)
        .map(Path::new)
    else {
        return false;
    };
    [
        ("package.json", OMP_PACKAGE),
        ("extensions/term-server-agent-events.ts", OMP_EXTENSION),
        ("extensions/subagent-activity.ts", OMP_ACTIVITY),
    ]
    .iter()
    .all(|(relative, expected)| {
        std::fs::read_to_string(root.join(relative)).is_ok_and(|content| content == *expected)
    })
}

fn omp_profile_status(
    profile: &OmpProfile,
    state: AgentIntegrationState,
    message: &str,
) -> AgentIntegrationProfileStatus {
    AgentIntegrationProfileStatus {
        id: profile.id.clone(),
        label: profile.label.clone(),
        state,
        message: message.to_owned(),
    }
}

fn classify_omp_profile_status(
    profile: &OmpProfile,
    collision: bool,
    registered: bool,
    installed: bool,
    enabled: bool,
    assets_current: bool,
) -> AgentIntegrationProfileStatus {
    if collision {
        return omp_profile_status(
            profile,
            AgentIntegrationState::NeedsRepair,
            "A different marketplace already uses the term-server-local name; this profile was not changed.",
        );
    }
    if !registered && !installed {
        return omp_profile_status(
            profile,
            AgentIntegrationState::NotInstalled,
            "Native events are off for this profile; process/output inference remains active.",
        );
    }
    if !registered || !installed || !enabled || !assets_current {
        return omp_profile_status(
            profile,
            AgentIntegrationState::NeedsRepair,
            "The managed OMP package is missing, disabled, or out of date for this profile; process/output inference remains active.",
        );
    }
    omp_profile_status(
        profile,
        AgentIntegrationState::Installed,
        "Installed and active for this OMP profile.",
    )
}

fn aggregate_omp_status(profiles: Vec<AgentIntegrationProfileStatus>) -> AgentIntegrationStatus {
    let state = if profiles.is_empty() {
        AgentIntegrationState::NotInstalled
    } else if profiles
        .iter()
        .all(|profile| profile.state == AgentIntegrationState::Installed)
    {
        AgentIntegrationState::Installed
    } else if profiles
        .iter()
        .all(|profile| profile.state == AgentIntegrationState::NotInstalled)
    {
        AgentIntegrationState::NotInstalled
    } else {
        AgentIntegrationState::NeedsRepair
    };
    let message = match state {
        AgentIntegrationState::Installed => {
            "Installed and active for all OMP profiles.".to_owned()
        }
        AgentIntegrationState::NotInstalled if profiles.is_empty() => {
            "No OMP profiles are configured; native events are off; process/output inference remains active."
                .to_owned()
        }
        AgentIntegrationState::NotInstalled => {
            "Native events are off for all OMP profiles; process/output inference remains active."
                .to_owned()
        }
        AgentIntegrationState::NeedsRepair => {
            "OMP integration differs across profiles; Repair applies the managed package to every profile. Process/output inference remains active."
                .to_owned()
        }
        AgentIntegrationState::Unavailable => {
            "OMP is not available on this server.".to_owned()
        }
    };
    AgentIntegrationStatus {
        provider: AgentIntegrationProvider::Omp,
        name: AgentIntegrationProvider::Omp.label().to_owned(),
        state,
        message,
        profiles: Some(profiles),
    }
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
        profiles: None,
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

    #[cfg(unix)]
    fn hook_commands(manifest: &str) -> Vec<String> {
        let manifest: Value = serde_json::from_str(manifest).unwrap();
        manifest["hooks"]
            .as_object()
            .unwrap()
            .values()
            .flat_map(|groups| groups.as_array().unwrap())
            .flat_map(|group| group["hooks"].as_array().unwrap())
            .map(|hook| hook["command"].as_str().unwrap().to_owned())
            .collect()
    }

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

    #[cfg(unix)]
    #[test]
    fn managed_hooks_detach_delivery_without_closing_stdin() {
        use std::{
            io::Write,
            os::unix::fs::PermissionsExt,
            process::{Command as StdCommand, Stdio as StdStdio},
            thread,
            time::{Duration, Instant},
        };

        for manifest in [CODEX_HOOKS, CLAUDE_HOOKS] {
            for command in hook_commands(manifest) {
                assert!(command.contains("exec 3<&0"));
                assert!(command.contains("<&3 >/dev/null 2>&1 &"));
            }
        }

        let directory = tempfile::tempdir().unwrap();
        let helper = directory.path().join("slow-agent-event");
        let capture = directory.path().join("stdin");
        std::fs::write(&helper, "#!/bin/sh\ncat >\"$HOOK_CAPTURE\"\nsleep 2\n").unwrap();
        let mut permissions = std::fs::metadata(&helper).unwrap().permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&helper, permissions).unwrap();

        let command = hook_commands(CODEX_HOOKS).into_iter().next().unwrap();
        let input = vec![b'x'; 2 * 1024 * 1024];
        let started = Instant::now();
        let mut hook = StdCommand::new("sh")
            .arg("-c")
            .arg(command)
            .env("TERM_SERVER_EXECUTABLE", &helper)
            .env("TERM_SERVER_SESSION", "test")
            .env("TERM_SERVER_BROKER_SOCKET", "test")
            .env("HOOK_CAPTURE", &capture)
            .stdin(StdStdio::piped())
            .stdout(StdStdio::null())
            .stderr(StdStdio::null())
            .spawn()
            .unwrap();
        hook.stdin
            .take()
            .unwrap()
            .write_all(&input)
            .expect("the detached reader must keep hook stdin open");
        assert!(hook.wait().unwrap().success());
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "the hook waited for the slow event forwarder"
        );

        for _ in 0..100 {
            if std::fs::metadata(&capture)
                .is_ok_and(|metadata| metadata.len() == input.len() as u64)
            {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(std::fs::read(&capture).unwrap(), input);
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
    #[test]
    fn discovers_default_and_all_valid_named_profiles_in_an_isolated_root() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(directory.path().join("profiles/work/agent")).unwrap();
        std::fs::create_dir_all(directory.path().join("profiles/review-2")).unwrap();
        std::fs::create_dir_all(directory.path().join("profiles/Upper")).unwrap();
        std::fs::create_dir_all(directory.path().join("profiles/with_under_score")).unwrap();
        std::fs::create_dir_all(directory.path().join("profiles/trailing-")).unwrap();
        std::fs::create_dir_all(directory.path().join("profiles/trailing.")).unwrap();

        let service =
            AgentIntegrationService::new_with_omp_config_root(directory.path(), directory.path());
        let profiles = service.omp_profiles();
        assert_eq!(
            profiles
                .into_iter()
                .map(|profile| profile.id)
                .collect::<Vec<_>>(),
            vec![
                "default",
                "review-2",
                "trailing-",
                "with_under_score",
                "work"
            ]
        );
    }

    #[test]
    fn profile_names_match_omp_normalization_rules() {
        assert!(valid_omp_profile_name("with_under_score"));
        assert!(valid_omp_profile_name("trailing-"));
        assert!(valid_omp_profile_name("a.b"));
        assert!(valid_omp_profile_name("con-"));
        assert!(valid_omp_profile_name(&"a".repeat(64)));
        assert!(!valid_omp_profile_name("Upper"));
        assert!(!valid_omp_profile_name("trailing."));
        assert!(!valid_omp_profile_name("con"));
        assert!(!valid_omp_profile_name("con.txt"));
        assert!(!valid_omp_profile_name("com1"));
        assert!(!valid_omp_profile_name(&"b".repeat(65)));
    }

    #[test]
    fn aggregate_state_reports_mixed_profiles_deterministically() {
        let default = OmpProfile {
            id: "default".to_owned(),
            label: "Default".to_owned(),
        };
        let work = OmpProfile {
            id: "work".to_owned(),
            label: "work".to_owned(),
        };
        let review = OmpProfile {
            id: "review".to_owned(),
            label: "review".to_owned(),
        };
        let status = aggregate_omp_status(vec![
            classify_omp_profile_status(&default, false, true, true, true, true),
            classify_omp_profile_status(&work, false, false, false, false, false),
            classify_omp_profile_status(&review, true, false, true, true, true),
        ]);
        assert_eq!(status.state, AgentIntegrationState::NeedsRepair);
        assert_eq!(status.profiles.as_ref().unwrap().len(), 3);
        assert!(status.message.contains("every profile"));
    }

    #[test]
    fn current_profile_assets_make_repair_idempotent() {
        let directory = tempfile::tempdir().unwrap();
        for (relative, content) in [
            ("package.json", OMP_PACKAGE),
            ("extensions/term-server-agent-events.ts", OMP_EXTENSION),
            ("extensions/subagent-activity.ts", OMP_ACTIVITY),
        ] {
            let path = directory.path().join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, content).unwrap();
        }
        let plugin = serde_json::json!({
            "id": PLUGIN_SELECTOR,
            "scope": "user",
            "enabled": true,
            "installPath": directory.path().to_string_lossy().to_string()
        });
        assert!(!omp_plugin_needs_install(true, Some(&plugin)));
        assert!(omp_plugin_needs_install(false, Some(&plugin)));
        assert!(omp_plugin_needs_install(
            true,
            Some(&serde_json::json!({
                "id": PLUGIN_SELECTOR,
                "scope": "user",
                "enabled": false,
                "installPath": directory.path().to_string_lossy().to_string()
            }))
        ));
    }

    #[test]
    fn removal_owns_only_user_scope_plugin_entries() {
        let user = serde_json::json!({
            "id": PLUGIN_SELECTOR,
            "scope": "user",
            "installPath": "/managed/cache"
        });
        let project = serde_json::json!({
            "id": PLUGIN_SELECTOR,
            "scope": "project",
            "installPath": "/user/project"
        });
        assert!(omp_plugin_user_owned(&user));
        assert!(!omp_plugin_user_owned(&project));
        assert!(!omp_plugin_user_owned(&serde_json::json!({
            "id": PLUGIN_SELECTOR,
            "entries": [project]
        })));
    }

    #[test]
    fn marker_matches_the_exact_installed_user_entry_identity() {
        let directory = tempfile::tempdir().unwrap();
        let profile = OmpProfile {
            id: "work".to_owned(),
            label: "work".to_owned(),
        };
        let plugin_root = directory.path().join("plugin");
        for (relative, content) in [
            ("package.json", OMP_PACKAGE),
            ("extensions/term-server-agent-events.ts", OMP_EXTENSION),
            ("extensions/subagent-activity.ts", OMP_ACTIVITY),
        ] {
            let path = plugin_root.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, content).unwrap();
        }
        let plugin = serde_json::json!({
            "id": PLUGIN_SELECTOR,
            "scope": "user",
            "enabled": true,
            "installPath": plugin_root.to_string_lossy().to_string(),
            "version": "0.1.0",
            "installedAt": "2026-08-10T00:00:00.000Z",
            "lastUpdated": "2026-08-10T00:00:00.000Z"
        });
        assert!(omp_plugin_assets_current(&plugin));
        let marker_value = omp_profile_ownership_marker_value(&plugin).unwrap();
        assert_eq!(
            marker_value.install_path.as_str(),
            plugin["installPath"].as_str().unwrap()
        );
        assert_eq!(marker_value.version, "0.1.0");
        assert_eq!(marker_value.installed_at, "2026-08-10T00:00:00.000Z");
        assert_eq!(marker_value.last_updated_at, "2026-08-10T00:00:00.000Z");

        let marker = omp_profile_ownership_marker(directory.path(), &profile);
        assert!(!omp_profile_marker_current(
            directory.path(),
            &profile,
            Some(&plugin)
        ));
        std::fs::create_dir_all(marker.parent().unwrap()).unwrap();
        std::fs::write(&marker, serde_json::to_vec(&marker_value).unwrap()).unwrap();
        assert!(omp_profile_marker_current(
            directory.path(),
            &profile,
            Some(&plugin)
        ));
        assert!(omp_profile_owns_plugin(None, directory.path(), true));
        assert!(
            omp_user_plugin_should_uninstall(&profile, None, directory.path(), true, true,)
                .unwrap()
        );

        let mut changed_timestamp = plugin.clone();
        changed_timestamp["lastUpdated"] = serde_json::json!("2026-08-10T00:01:00.000Z");
        assert!(!omp_profile_marker_current(
            directory.path(),
            &profile,
            Some(&changed_timestamp)
        ));
        let mut changed_version = plugin.clone();
        changed_version["version"] = serde_json::json!("0.2.0");
        assert!(!omp_profile_marker_current(
            directory.path(),
            &profile,
            Some(&changed_version)
        ));
    }

    #[test]
    fn foreign_same_content_plugin_is_not_owned_by_term_server() {
        let directory = tempfile::tempdir().unwrap();
        let foreign_marketplace = directory.path().join("foreign-marketplace");
        for (relative, content) in [
            ("package.json", OMP_PACKAGE),
            ("extensions/term-server-agent-events.ts", OMP_EXTENSION),
            ("extensions/subagent-activity.ts", OMP_ACTIVITY),
        ] {
            let path = foreign_marketplace.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, content).unwrap();
        }
        let plugin = serde_json::json!({
            "id": PLUGIN_SELECTOR,
            "scope": "user",
            "enabled": true,
            "installPath": foreign_marketplace.to_string_lossy().to_string()
        });
        assert!(omp_plugin_assets_current(&plugin));
        assert!(!omp_profile_owns_plugin(
            Some(&foreign_marketplace),
            directory.path(),
            true
        ));
        assert!(!omp_profile_owns_plugin(None, directory.path(), false));
    }
    #[test]
    fn unmarked_orphan_user_plugin_blocks_repair_without_mutation() {
        let directory = tempfile::tempdir().unwrap();
        let profile = OmpProfile {
            id: "work".to_owned(),
            label: "work".to_owned(),
        };
        let error = omp_user_plugin_should_uninstall(&profile, None, directory.path(), false, true)
            .unwrap_err();
        assert!(error.contains("work"));
        assert!(error.contains("unowned user plugin"));
        assert!(
            !omp_user_plugin_should_uninstall(&profile, None, directory.path(), false, false,)
                .unwrap()
        );
    }

    #[test]
    fn foreign_marketplace_collision_returns_an_install_error() {
        let profile = OmpProfile {
            id: "review".to_owned(),
            label: "review".to_owned(),
        };
        let error = omp_marketplace_collision_error(&profile);
        assert!(error.contains("review"));
        assert!(error.contains(MARKETPLACE_NAME));
        assert!(error.contains("different marketplace"));
    }

    #[test]
    fn fresh_empty_root_still_targets_the_default_profile() {
        let directory = tempfile::tempdir().unwrap();
        let profiles = discover_omp_profiles_from(directory.path());
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].id, "default");
        let status = aggregate_omp_status(vec![omp_profile_status(
            &profiles[0],
            AgentIntegrationState::NotInstalled,
            "Native events are off for this profile; process/output inference remains active.",
        )]);
        assert_eq!(status.state, AgentIntegrationState::NotInstalled);
        assert!(status.message.contains("all OMP profiles"));
    }

    #[test]
    fn hermes_config_editing_covers_common_shapes() {
        // An empty config gains the plugins.enabled allow-list entry.
        let added = ensure_hermes_plugin_enabled("");
        assert!(hermes_enabled_plugins_contain(
            &added,
            HERMES_PLUGIN_DIR_NAME
        ));
        assert_eq!(
            added,
            "plugins:\n  enabled:\n    - term-server-agent-events\n"
        );

        // Unrelated top-level keys are preserved.
        let base = "theme: dark\nmodel: hermes-4\n";
        let added = ensure_hermes_plugin_enabled(base);
        assert!(added.starts_with("theme: dark\nmodel: hermes-4\n"));
        assert!(hermes_enabled_plugins_contain(
            &added,
            HERMES_PLUGIN_DIR_NAME
        ));

        // An existing enabled list keeps its other entries.
        let existing = "theme: dark\nplugins:\n  enabled:\n    - some-other-plugin\n";
        let added = ensure_hermes_plugin_enabled(existing);
        assert!(hermes_enabled_plugins_contain(
            &added,
            HERMES_PLUGIN_DIR_NAME
        ));
        assert!(hermes_enabled_plugins_contain(&added, "some-other-plugin"));

        // An explicit empty list expands.
        let empty_list = "plugins:\n  enabled: []\n";
        let added = ensure_hermes_plugin_enabled(empty_list);
        assert!(hermes_enabled_plugins_contain(
            &added,
            HERMES_PLUGIN_DIR_NAME
        ));

        // A flat block list form is handled.
        let flat = "plugins:\n  - some-other-plugin\n";
        let added = ensure_hermes_plugin_enabled(flat);
        assert!(hermes_enabled_plugins_contain(
            &added,
            HERMES_PLUGIN_DIR_NAME
        ));
        assert!(hermes_enabled_plugins_contain(&added, "some-other-plugin"));

        // An inline flow list form is handled.
        let inline = "plugins: [some-other-plugin]\n";
        let added = ensure_hermes_plugin_enabled(inline);
        assert!(hermes_enabled_plugins_contain(
            &added,
            HERMES_PLUGIN_DIR_NAME
        ));
        assert!(hermes_enabled_plugins_contain(&added, "some-other-plugin"));

        // Remove leaves unrelated entries and is idempotent when absent.
        let removed = remove_hermes_plugin_enabled(&added);
        assert!(!hermes_enabled_plugins_contain(
            &removed,
            HERMES_PLUGIN_DIR_NAME
        ));
        assert!(hermes_enabled_plugins_contain(
            &removed,
            "some-other-plugin"
        ));
        assert_eq!(remove_hermes_plugin_enabled(&removed), removed);
    }

    #[test]
    fn hermes_plugin_files_and_assets_detect_state() {
        let directory = tempfile::tempdir().unwrap();
        assert!(!hermes_plugin_files_present(directory.path()));
        assert!(!hermes_plugin_assets_current(directory.path()));

        std::fs::write(directory.path().join("plugin.yaml"), HERMES_PLUGIN_YAML).unwrap();
        std::fs::write(directory.path().join("__init__.py"), HERMES_PLUGIN_INIT).unwrap();
        assert!(hermes_plugin_files_present(directory.path()));
        assert!(hermes_plugin_assets_current(directory.path()));

        // A stale asset is still present but not current.
        std::fs::write(directory.path().join("__init__.py"), "stale").unwrap();
        assert!(hermes_plugin_files_present(directory.path()));
        assert!(!hermes_plugin_assets_current(directory.path()));
    }

    #[tokio::test]
    async fn hermes_prepare_package_stages_current_assets() {
        let directory = tempfile::tempdir().unwrap();
        let service = AgentIntegrationService::new(directory.path());
        service
            .prepare_package(AgentIntegrationProvider::Hermes)
            .await
            .unwrap();
        assert!(service.assets_current(AgentIntegrationProvider::Hermes));
        let root = service.provider_root(AgentIntegrationProvider::Hermes);
        assert!(root.join("plugin.yaml").is_file());
        assert!(root.join("__init__.py").is_file());
        assert!(
            !service
                .provider_root(AgentIntegrationProvider::Claude)
                .exists()
        );
    }
}
