use serde::Serialize;

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

pub fn info() -> BuildInfo {
    BuildInfo {
        version: VERSION,
        commit: COMMIT,
    }
}
