use std::{
    collections::HashMap,
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tempfile::NamedTempFile;
use uuid::Uuid;

const STATE_FILE: &str = "activity-views.json";
const SCHEMA_VERSION: u8 = 1;

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityView {
    #[serde(default)]
    pub agent_completed_at: u64,
    #[serde(default)]
    pub command_completed_at: u64,
}

impl ActivityView {
    pub fn merge(self, update: Self) -> Self {
        Self {
            agent_completed_at: self.agent_completed_at.max(update.agent_completed_at),
            command_completed_at: self.command_completed_at.max(update.command_completed_at),
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredActivityViews {
    schema_version: u8,
    #[serde(default)]
    terminals: HashMap<Uuid, ActivityView>,
}

#[derive(Clone)]
pub struct ActivityViewService {
    path: Option<Arc<PathBuf>>,
    views: Arc<RwLock<HashMap<Uuid, ActivityView>>>,
}

impl ActivityViewService {
    pub fn new(data_directory: &Path) -> Self {
        let path = data_directory.join(STATE_FILE);
        let views = match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<StoredActivityViews>(&bytes) {
                Ok(stored) if stored.schema_version == SCHEMA_VERSION => stored.terminals,
                Ok(stored) => {
                    tracing::warn!(
                        path = %path.display(),
                        schema_version = stored.schema_version,
                        "ignoring activity views with an unsupported schema"
                    );
                    HashMap::new()
                }
                Err(error) => {
                    tracing::warn!(
                        %error,
                        path = %path.display(),
                        "ignoring invalid activity views"
                    );
                    HashMap::new()
                }
            },
            Err(error) if error.kind() == io::ErrorKind::NotFound => HashMap::new(),
            Err(error) => {
                tracing::warn!(
                    %error,
                    path = %path.display(),
                    "unable to load activity views"
                );
                HashMap::new()
            }
        };
        Self {
            path: Some(Arc::new(path)),
            views: Arc::new(RwLock::new(views)),
        }
    }

    #[cfg(test)]
    pub fn in_memory() -> Self {
        Self {
            path: None,
            views: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn get(&self, terminal_id: Uuid) -> ActivityView {
        self.views
            .read()
            .get(&terminal_id)
            .copied()
            .unwrap_or_default()
    }

    pub fn update(&self, terminal_id: Uuid, update: ActivityView) -> io::Result<ActivityView> {
        let mut views = self.views.write();
        let current = views.get(&terminal_id).copied().unwrap_or_default();
        let next = current.merge(update);
        if next == current {
            return Ok(current);
        }

        let mut updated = views.clone();
        updated.insert(terminal_id, next);
        self.persist(&updated)?;
        *views = updated;
        Ok(next)
    }

    pub fn remove(&self, terminal_id: Uuid) -> io::Result<()> {
        let mut views = self.views.write();
        if !views.contains_key(&terminal_id) {
            return Ok(());
        }

        let mut updated = views.clone();
        updated.remove(&terminal_id);
        self.persist(&updated)?;
        *views = updated;
        Ok(())
    }

    fn persist(&self, views: &HashMap<Uuid, ActivityView>) -> io::Result<()> {
        let Some(path) = self.path.as_deref() else {
            return Ok(());
        };
        let parent = path
            .parent()
            .ok_or_else(|| io::Error::other("activity view path has no parent"))?;
        fs::create_dir_all(parent)?;

        let stored = StoredActivityViews {
            schema_version: SCHEMA_VERSION,
            terminals: views.clone(),
        };
        let mut temporary = NamedTempFile::new_in(parent)?;
        serde_json::to_writer_pretty(&mut temporary, &stored).map_err(io::Error::other)?;
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
    fn updates_both_watermarks_monotonically() {
        let service = ActivityViewService::in_memory();
        let terminal_id = Uuid::new_v4();

        assert_eq!(
            service
                .update(
                    terminal_id,
                    ActivityView {
                        agent_completed_at: 90,
                        command_completed_at: 100,
                    },
                )
                .unwrap(),
            ActivityView {
                agent_completed_at: 90,
                command_completed_at: 100,
            }
        );
        assert_eq!(
            service
                .update(
                    terminal_id,
                    ActivityView {
                        agent_completed_at: 80,
                        command_completed_at: 120,
                    },
                )
                .unwrap(),
            ActivityView {
                agent_completed_at: 90,
                command_completed_at: 120,
            }
        );
    }

    #[test]
    fn concurrent_device_updates_preserve_both_newest_events() {
        let service = ActivityViewService::in_memory();
        let terminal_id = Uuid::new_v4();
        std::thread::scope(|scope| {
            let first = service.clone();
            scope.spawn(move || {
                first
                    .update(
                        terminal_id,
                        ActivityView {
                            agent_completed_at: 200,
                            command_completed_at: 0,
                        },
                    )
                    .unwrap();
            });
            let second = service.clone();
            scope.spawn(move || {
                second
                    .update(
                        terminal_id,
                        ActivityView {
                            agent_completed_at: 0,
                            command_completed_at: 300,
                        },
                    )
                    .unwrap();
            });
        });

        assert_eq!(
            service.get(terminal_id),
            ActivityView {
                agent_completed_at: 200,
                command_completed_at: 300,
            }
        );
    }

    #[test]
    fn persists_updates_and_removals_across_instances() {
        let directory = tempfile::tempdir().unwrap();
        let terminal_id = Uuid::new_v4();
        let service = ActivityViewService::new(directory.path());
        service
            .update(
                terminal_id,
                ActivityView {
                    agent_completed_at: 123,
                    command_completed_at: 456,
                },
            )
            .unwrap();

        let reloaded = ActivityViewService::new(directory.path());
        assert_eq!(
            reloaded.get(terminal_id),
            ActivityView {
                agent_completed_at: 123,
                command_completed_at: 456,
            }
        );
        reloaded.remove(terminal_id).unwrap();
        assert_eq!(
            ActivityViewService::new(directory.path()).get(terminal_id),
            ActivityView::default()
        );
    }

    #[cfg(unix)]
    #[test]
    fn persistence_file_is_private() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        ActivityViewService::new(directory.path())
            .update(
                Uuid::new_v4(),
                ActivityView {
                    agent_completed_at: 1,
                    command_completed_at: 2,
                },
            )
            .unwrap();

        let mode = fs::metadata(directory.path().join(STATE_FILE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o077, 0);
    }

    #[test]
    fn recovers_from_an_invalid_state_file() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join(STATE_FILE), b"not json").unwrap();
        let terminal_id = Uuid::new_v4();
        let service = ActivityViewService::new(directory.path());

        service
            .update(
                terminal_id,
                ActivityView {
                    agent_completed_at: 2,
                    command_completed_at: 0,
                },
            )
            .unwrap();
        assert_eq!(
            ActivityViewService::new(directory.path())
                .get(terminal_id)
                .agent_completed_at,
            2
        );
    }

    #[test]
    fn failed_persistence_does_not_acknowledge_in_memory() {
        let directory = tempfile::tempdir().unwrap();
        let invalid_data_directory = directory.path().join("not-a-directory");
        fs::write(&invalid_data_directory, b"file").unwrap();
        let service = ActivityViewService::new(&invalid_data_directory);
        let terminal_id = Uuid::new_v4();

        assert!(
            service
                .update(
                    terminal_id,
                    ActivityView {
                        agent_completed_at: 100,
                        command_completed_at: 200,
                    },
                )
                .is_err()
        );
        assert_eq!(service.get(terminal_id), ActivityView::default());
    }
}
