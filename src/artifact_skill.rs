use std::{
    env, fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::agent_integrations::AgentIntegrationProvider;

const SKILL_NAME: &str = "term-server-artifacts";
const CORE_FILES: &[&str] = &["SKILL.md", "scripts/create_artifact.py"];
const EMBEDDED_ASSETS: &[(&str, &[u8], u32)] = &[
    (
        "SKILL.md",
        include_bytes!("../skills/term-server-artifacts/SKILL.md"),
        0o644,
    ),
    (
        "scripts/create_artifact.py",
        include_bytes!("../skills/term-server-artifacts/scripts/create_artifact.py"),
        0o755,
    ),
    (
        "agents/openai.yaml",
        include_bytes!("../skills/term-server-artifacts/agents/openai.yaml"),
        0o644,
    ),
];

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ArtifactSkillState {
    Unavailable,
    NotInstalled,
    Installed,
    External,
    Outdated,
    Broken,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactSkillStatus {
    pub provider: AgentIntegrationProvider,
    pub name: String,
    pub state: ArtifactSkillState,
    pub message: String,
    pub path: String,
    pub repairable: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactSkillConfig {
    pub available: bool,
    pub source: Option<String>,
    pub message: Option<String>,
    pub providers: Vec<ArtifactSkillStatus>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArtifactSkillAction {
    Install,
    Repair,
    Remove,
}

#[derive(Debug)]
pub struct ArtifactSkillService {
    source: Option<PathBuf>,
    unavailable_reason: Option<String>,
    destinations: Vec<(AgentIntegrationProvider, PathBuf)>,
}

impl ArtifactSkillService {
    pub fn discover() -> Self {
        let (source, unavailable_reason) = discover_source();
        let destinations = agent_destinations();
        Self {
            source,
            unavailable_reason,
            destinations,
        }
    }

    #[cfg(test)]
    pub(crate) fn new(source: Option<PathBuf>, home: &Path) -> Self {
        Self {
            source,
            unavailable_reason: None,
            destinations: destinations_for_home(home, None),
        }
    }

    pub fn status(&self) -> ArtifactSkillConfig {
        ArtifactSkillConfig {
            available: self.source.is_some(),
            source: self.source.as_ref().map(|path| path.display().to_string()),
            message: self.unavailable_reason.clone(),
            providers: self
                .destinations
                .iter()
                .map(|(provider, destination)| self.provider_status(*provider, destination))
                .collect(),
        }
    }

    pub fn apply(
        &self,
        provider: AgentIntegrationProvider,
        action: ArtifactSkillAction,
    ) -> Result<ArtifactSkillConfig, String> {
        let destination = self
            .destinations
            .iter()
            .find_map(|(candidate, path)| (*candidate == provider).then_some(path))
            .ok_or_else(|| "unknown agent provider".to_owned())?;
        let source = self.require_source()?;

        match action {
            ArtifactSkillAction::Install => install_link(source, destination, false)?,
            ArtifactSkillAction::Repair => install_link(source, destination, true)?,
            ArtifactSkillAction::Remove => remove_managed_link(source, destination)?,
        }
        Ok(self.status())
    }

    fn require_source(&self) -> Result<&Path, String> {
        self.source
            .as_deref()
            .ok_or_else(|| "the bundled artifact skill is unavailable".to_owned())
    }

    fn provider_status(
        &self,
        provider: AgentIntegrationProvider,
        destination: &Path,
    ) -> ArtifactSkillStatus {
        let name = provider.label().to_owned();
        let path = destination.display().to_string();
        let Some(source) = self.source.as_deref() else {
            return ArtifactSkillStatus {
                provider,
                name,
                state: ArtifactSkillState::Unavailable,
                message: self.unavailable_reason.clone().unwrap_or_else(|| {
                    "The bundled artifact skill is unavailable in this installation.".into()
                }),
                path,
                repairable: false,
            };
        };
        if !destination.is_absolute() {
            return ArtifactSkillStatus {
                provider,
                name,
                state: ArtifactSkillState::Unavailable,
                message: "The agent home directory is unavailable.".into(),
                path,
                repairable: false,
            };
        }

        let metadata = match fs::symlink_metadata(destination) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                return ArtifactSkillStatus {
                    provider,
                    name,
                    state: ArtifactSkillState::NotInstalled,
                    message: "The artifact skill is not installed for this agent.".into(),
                    path,
                    repairable: false,
                };
            }
            Err(error) => {
                return ArtifactSkillStatus {
                    provider,
                    name,
                    state: ArtifactSkillState::Broken,
                    message: format!("Unable to inspect the artifact skill: {error}"),
                    path,
                    repairable: false,
                };
            }
        };

        if metadata.file_type().is_symlink() {
            match resolved_link(destination) {
                Ok(target) if same_path(&target, source) => ArtifactSkillStatus {
                    provider,
                    name,
                    state: ArtifactSkillState::Installed,
                    message: "Using the bundled term-server skill; updates stay synchronized."
                        .into(),
                    path,
                    repairable: false,
                },
                Ok(target) if core_files_match(&target, source) => ArtifactSkillStatus {
                    provider,
                    name,
                    state: ArtifactSkillState::External,
                    message: format!(
                        "A matching external skill is linked from {}; it will not follow term-server updates.",
                        target.display()
                    ),
                    path,
                    repairable: true,
                },
                Ok(target) if target.exists() => ArtifactSkillStatus {
                    provider,
                    name,
                    state: ArtifactSkillState::Outdated,
                    message: format!(
                        "An external skill at {} differs from the bundled version.",
                        target.display()
                    ),
                    path,
                    repairable: true,
                },
                Ok(target) => ArtifactSkillStatus {
                    provider,
                    name,
                    state: ArtifactSkillState::Broken,
                    message: format!(
                        "The artifact skill link points to missing path {}.",
                        target.display()
                    ),
                    path,
                    repairable: true,
                },
                Err(error) => ArtifactSkillStatus {
                    provider,
                    name,
                    state: ArtifactSkillState::Broken,
                    message: format!("Unable to read the artifact skill link: {error}"),
                    path,
                    repairable: true,
                },
            }
        } else if metadata.is_dir() && core_files_match(destination, source) {
            ArtifactSkillStatus {
                provider,
                name,
                state: ArtifactSkillState::External,
                message:
                    "A matching standalone skill is installed; it will not follow term-server updates."
                        .into(),
                path,
                repairable: false,
            }
        } else {
            ArtifactSkillStatus {
                provider,
                name,
                state: ArtifactSkillState::Outdated,
                message:
                    "Another file or directory occupies the artifact skill path and differs from the bundled version."
                        .into(),
                path,
                repairable: false,
            }
        }
    }
}

fn discover_source() -> (Option<PathBuf>, Option<String>) {
    if let Some(root) = env::var_os("TERM_SERVER_SKILLS_DIR") {
        let candidate = PathBuf::from(root).join(SKILL_NAME);
        return if core_files_exist(&candidate) {
            match candidate.canonicalize() {
                Ok(candidate) => (Some(candidate), None),
                Err(error) => (None, Some(error.to_string())),
            }
        } else {
            (
                None,
                Some(format!(
                    "{} does not contain the artifact skill",
                    candidate.display()
                )),
            )
        };
    }

    let root = match env::current_exe()
        .ok()
        .and_then(|executable| executable.parent().map(Path::to_owned))
    {
        Some(root) if root.join("client/index.html").is_file() => root,
        _ => {
            return (
                None,
                Some("Artifact skill management is available in installed releases.".into()),
            );
        }
    };
    match ensure_bundled_source(&root) {
        Ok(source) => (Some(source), None),
        Err(error) => (None, Some(error)),
    }
}

fn agent_destinations() -> Vec<(AgentIntegrationProvider, PathBuf)> {
    let home = env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let codex_home = env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute());
    destinations_for_home(&home, codex_home.as_deref())
}

fn destinations_for_home(
    home: &Path,
    codex_home: Option<&Path>,
) -> Vec<(AgentIntegrationProvider, PathBuf)> {
    let codex_home = codex_home
        .map(Path::to_owned)
        .unwrap_or_else(|| home.join(".codex"));
    vec![
        (
            AgentIntegrationProvider::Codex,
            codex_home.join("skills").join(SKILL_NAME),
        ),
        (
            AgentIntegrationProvider::Claude,
            home.join(".claude/skills").join(SKILL_NAME),
        ),
        (
            AgentIntegrationProvider::Pi,
            home.join(".pi/agent/skills").join(SKILL_NAME),
        ),
    ]
}

fn core_files_exist(root: &Path) -> bool {
    CORE_FILES
        .iter()
        .all(|relative| root.join(relative).is_file())
}

fn core_files_match(left: &Path, right: &Path) -> bool {
    CORE_FILES.iter().all(|relative| {
        let left = fs::read(left.join(relative));
        let right = fs::read(right.join(relative));
        matches!((left, right), (Ok(left), Ok(right)) if left == right)
    })
}

fn embedded_assets_match(root: &Path) -> bool {
    EMBEDDED_ASSETS.iter().all(|(relative, expected, mode)| {
        let path = root.join(relative);
        fs::read(&path).is_ok_and(|actual| actual == *expected)
            && embedded_mode_matches(&path, *mode)
    })
}

#[cfg(unix)]
fn embedded_mode_matches(path: &Path, expected: u32) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .is_ok_and(|metadata| metadata.permissions().mode() & 0o777 == expected)
}

#[cfg(not(unix))]
fn embedded_mode_matches(_path: &Path, _expected: u32) -> bool {
    true
}

fn ensure_bundled_source(installation_root: &Path) -> Result<PathBuf, String> {
    let skills_root = installation_root.join("skills");
    match fs::symlink_metadata(&skills_root) {
        Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
            return Err(format!(
                "{} is not a managed skill directory",
                skills_root.display()
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {
            fs::create_dir(&skills_root)
                .map_err(|error| format!("unable to create {}: {error}", skills_root.display()))?;
        }
        Err(error) => return Err(error.to_string()),
    }

    let source = skills_root.join(SKILL_NAME);
    match fs::symlink_metadata(&source) {
        Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
            return Err(format!("{} is not a managed directory", source.display()));
        }
        Ok(_) if embedded_assets_match(&source) => {
            return source.canonicalize().map_err(|error| error.to_string());
        }
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }

    let identifier = Uuid::new_v4();
    let staging = skills_root.join(format!(".{SKILL_NAME}.new-{identifier}"));
    let previous = skills_root.join(format!(".{SKILL_NAME}.previous-{identifier}"));
    fs::create_dir(&staging).map_err(|error| error.to_string())?;
    let result = (|| {
        for (relative, content, mode) in EMBEDDED_ASSETS {
            let destination = staging.join(relative);
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::write(&destination, content).map_err(|error| error.to_string())?;
            set_mode(&destination, *mode)?;
        }

        let had_previous = source.exists();
        if had_previous {
            fs::rename(&source, &previous).map_err(|error| error.to_string())?;
        }
        if let Err(error) = fs::rename(&staging, &source) {
            if had_previous {
                let _ = fs::rename(&previous, &source);
            }
            return Err(error.to_string());
        }
        if had_previous {
            let _ = fs::remove_dir_all(&previous);
        }
        source.canonicalize().map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> Result<(), String> {
    Ok(())
}

fn resolved_link(link: &Path) -> Result<PathBuf, std::io::Error> {
    let target = fs::read_link(link)?;
    if target.is_absolute() {
        Ok(target)
    } else {
        Ok(link.parent().unwrap_or_else(|| Path::new(".")).join(target))
    }
}

fn same_path(left: &Path, right: &Path) -> bool {
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

#[cfg(unix)]
fn install_link(source: &Path, destination: &Path, replace: bool) -> Result<(), String> {
    use std::os::unix::fs::symlink;

    if !destination.is_absolute() {
        return Err("the agent home directory is unavailable".to_owned());
    }
    let parent = destination
        .parent()
        .ok_or_else(|| "the artifact skill destination has no parent directory".to_owned())?;
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "unable to create artifact skill directory {}: {error}",
            parent.display()
        )
    })?;

    match fs::symlink_metadata(destination) {
        Ok(_) if !replace => {
            return Err(format!(
                "{} already exists; use repair to adopt the bundled skill",
                destination.display()
            ));
        }
        Ok(metadata) if !metadata.file_type().is_symlink() => {
            return Err(format!(
                "{} is not a symlink; move it aside before adopting the bundled skill",
                destination.display()
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }

    let temporary = parent.join(format!(".{SKILL_NAME}.new-{}", Uuid::new_v4()));
    symlink(source, &temporary).map_err(|error| error.to_string())?;
    if let Err(error) = fs::rename(&temporary, destination) {
        let _ = fs::remove_file(&temporary);
        return Err(format!(
            "unable to install artifact skill at {}: {error}",
            destination.display()
        ));
    }
    Ok(())
}

#[cfg(not(unix))]
fn install_link(_source: &Path, _destination: &Path, _replace: bool) -> Result<(), String> {
    Err("artifact skill links are currently supported on Unix only".to_owned())
}

fn remove_managed_link(source: &Path, destination: &Path) -> Result<(), String> {
    if !destination.is_absolute() {
        return Err("the agent home directory is unavailable".to_owned());
    }
    let metadata = fs::symlink_metadata(destination)
        .map_err(|error| format!("unable to inspect {}: {error}", destination.display()))?;
    if !metadata.file_type().is_symlink()
        || !resolved_link(destination).is_ok_and(|target| same_path(&target, source))
    {
        return Err("refusing to remove an artifact skill not managed by term-server".to_owned());
    }
    fs::remove_file(destination)
        .map_err(|error| format!("unable to remove {}: {error}", destination.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_skill(root: &Path, marker: &str) {
        fs::create_dir_all(root.join("scripts")).unwrap();
        fs::write(root.join("SKILL.md"), format!("skill {marker}")).unwrap();
        fs::write(
            root.join("scripts/create_artifact.py"),
            format!("script {marker}"),
        )
        .unwrap();
    }

    #[test]
    fn installs_reports_and_removes_managed_links() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source");
        let home = directory.path().join("home");
        write_skill(&source, "current");
        let service = ArtifactSkillService::new(Some(source.clone()), &home);

        let before = service.status();
        assert!(
            before
                .providers
                .iter()
                .all(|status| status.state == ArtifactSkillState::NotInstalled)
        );

        let installed = service
            .apply(
                AgentIntegrationProvider::Codex,
                ArtifactSkillAction::Install,
            )
            .unwrap();
        assert_eq!(installed.providers[0].state, ArtifactSkillState::Installed);

        service
            .apply(AgentIntegrationProvider::Codex, ArtifactSkillAction::Remove)
            .unwrap();
        assert_eq!(
            service.status().providers[0].state,
            ArtifactSkillState::NotInstalled
        );
    }

    #[cfg(unix)]
    #[test]
    fn distinguishes_matching_outdated_and_broken_external_links() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source");
        let external = directory.path().join("external");
        let home = directory.path().join("home");
        let destination = home.join(".codex/skills").join(SKILL_NAME);
        write_skill(&source, "current");
        write_skill(&external, "current");
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        symlink(&external, &destination).unwrap();
        let service = ArtifactSkillService::new(Some(source), &home);
        assert_eq!(
            service.status().providers[0].state,
            ArtifactSkillState::External
        );

        fs::write(external.join("SKILL.md"), "old").unwrap();
        assert_eq!(
            service.status().providers[0].state,
            ArtifactSkillState::Outdated
        );

        fs::remove_dir_all(&external).unwrap();
        assert_eq!(
            service.status().providers[0].state,
            ArtifactSkillState::Broken
        );
    }

    #[test]
    fn refuses_to_replace_real_directories() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source");
        let home = directory.path().join("home");
        let destination = home.join(".codex/skills").join(SKILL_NAME);
        write_skill(&source, "current");
        write_skill(&destination, "old");
        let service = ArtifactSkillService::new(Some(source), &home);
        assert!(!service.status().providers[0].repairable);

        let error = service
            .apply(AgentIntegrationProvider::Codex, ArtifactSkillAction::Repair)
            .unwrap_err();
        assert!(error.contains("is not a symlink"));
    }

    #[test]
    fn repairs_the_bundled_skill_from_embedded_assets() {
        let directory = tempfile::tempdir().unwrap();
        let client = directory.path().join("client");
        let source = directory.path().join("skills").join(SKILL_NAME);
        fs::create_dir(&client).unwrap();
        fs::write(client.join("index.html"), "client").unwrap();
        write_skill(&source, "old");

        let installed = ensure_bundled_source(directory.path()).unwrap();
        assert_eq!(installed, source.canonicalize().unwrap());
        assert!(embedded_assets_match(&installed));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let helper = installed.join("scripts/create_artifact.py");
            fs::set_permissions(&helper, fs::Permissions::from_mode(0o644)).unwrap();
            assert!(!embedded_assets_match(&installed));
            ensure_bundled_source(directory.path()).unwrap();
            assert!(embedded_assets_match(&installed));
        }
    }
}
