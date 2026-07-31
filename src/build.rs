use serde::{Deserialize, Serialize};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const COMMIT: &str = env!("TERM_SERVER_BUILD_COMMIT");
pub const LONG_VERSION: &str = concat!(
    env!("CARGO_PKG_VERSION"),
    " (commit ",
    env!("TERM_SERVER_BUILD_COMMIT"),
    ")"
);

#[derive(Debug, Clone, Serialize)]
pub struct BuildInfo {
    pub version: &'static str,
    pub commit: &'static str,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct BuildIdentity {
    pub version: String,
    pub commit: String,
}

impl BuildIdentity {
    pub fn current() -> Self {
        Self {
            version: VERSION.to_owned(),
            commit: COMMIT.to_owned(),
        }
    }

    pub fn is_current(&self) -> bool {
        self.version == VERSION && self.commit == COMMIT
    }
}

pub fn info() -> BuildInfo {
    BuildInfo {
        version: VERSION,
        commit: COMMIT,
    }
}
