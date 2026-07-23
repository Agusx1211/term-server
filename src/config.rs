use std::{env, net::IpAddr, path::PathBuf};

use clap::{ArgAction, Parser};

fn default_data_dir() -> PathBuf {
    if let Some(path) = env::var_os("XDG_DATA_HOME") {
        return PathBuf::from(path).join("term-server");
    }
    if let Some(home) = env::var_os("HOME") {
        return PathBuf::from(home).join(".local/share/term-server");
    }
    PathBuf::from(".term-server")
}

fn default_client_dir() -> PathBuf {
    let mut candidates = Vec::new();

    if let Ok(executable) = env::current_exe()
        && let Some(directory) = executable.parent()
    {
        candidates.push(directory.join("client"));
    }

    candidates.push(PathBuf::from("dist/client"));

    if let Some(path) = env::var_os("XDG_DATA_HOME") {
        candidates.push(PathBuf::from(path).join("term-server/client"));
    } else if let Some(home) = env::var_os("HOME") {
        candidates.push(PathBuf::from(home).join(".local/share/term-server/client"));
    }

    candidates.push(PathBuf::from("/usr/local/share/term-server/client"));
    candidates.push(PathBuf::from("/usr/share/term-server/client"));

    candidates
        .into_iter()
        .find(|candidate| candidate.join("index.html").is_file())
        .unwrap_or_else(|| PathBuf::from("dist/client"))
}

#[derive(Debug, Clone, Parser)]
#[command(
    name = "term-server",
    version,
    long_version = crate::build::LONG_VERSION,
    about,
    long_about = None
)]
pub struct Cli {
    /// Address to listen on.
    #[arg(long, env = "TERM_SERVER_HOST", default_value = "127.0.0.1")]
    pub host: String,

    /// TCP port to listen on.
    #[arg(long, env = "TERM_SERVER_PORT", default_value_t = 8090)]
    pub port: u16,

    /// Disable HTTPS. HTTPS with an automatically generated certificate is the default.
    #[arg(long, env = "TERM_SERVER_NO_HTTPS", action = ArgAction::SetTrue)]
    pub no_https: bool,

    /// Mark the session cookie Secure when TLS terminates at a reverse proxy.
    #[arg(long, env = "TERM_SERVER_SECURE_COOKIE", action = ArgAction::SetTrue)]
    pub secure_cookie: bool,

    /// PEM certificate to use instead of the generated self-signed certificate.
    #[arg(long, env = "TERM_SERVER_CERT", requires = "cert_key")]
    pub cert: Option<PathBuf>,

    /// PEM private key paired with --cert.
    #[arg(long, env = "TERM_SERVER_CERT_KEY", requires = "cert")]
    pub cert_key: Option<PathBuf>,

    /// Additional hostname for the generated TLS certificate. May be repeated or comma-separated.
    #[arg(
        long = "tls-hostname",
        env = "TERM_SERVER_TLS_HOSTNAMES",
        value_delimiter = ','
    )]
    pub tls_hostnames: Vec<String>,

    /// Read the login password from a file. TERM_SERVER_PASSWORD takes precedence.
    #[arg(long, env = "TERM_SERVER_PASSWORD_FILE")]
    pub password_file: Option<PathBuf>,

    /// Directory for credentials and generated TLS material.
    #[arg(long, env = "TERM_SERVER_DATA_DIR", default_value_os_t = default_data_dir())]
    pub data_dir: PathBuf,

    /// Default shell executable used for new terminals.
    #[arg(long, env = "TERM_SERVER_SHELL")]
    pub shell: Option<String>,

    /// Additional allowed browser origin. May be repeated or comma-separated.
    #[arg(
        long = "allowed-origin",
        env = "TERM_SERVER_ALLOWED_ORIGINS",
        value_delimiter = ','
    )]
    pub allowed_origins: Vec<String>,

    /// Reconnect history retained per terminal, in MiB.
    #[arg(long, env = "TERM_SERVER_REPLAY_MB", default_value_t = 16, value_parser = clap::value_parser!(u64).range(1..=1024))]
    pub replay_mb: u64,

    /// Number of scrollback rows retained by each browser terminal.
    #[arg(long, env = "TERM_SERVER_SCROLLBACK_LINES", default_value_t = 200_000, value_parser = clap::value_parser!(u32).range(1_000..=2_000_000))]
    pub scrollback_lines: u32,

    /// Maximum number of simultaneously visible terminal panes.
    #[arg(long, env = "TERM_SERVER_MAX_PANES", default_value_t = 4, value_parser = clap::value_parser!(u8).range(1..=8))]
    pub max_panes: u8,

    /// Directory containing the compiled browser application.
    #[arg(long, env = "TERM_SERVER_CLIENT_DIR", default_value_os_t = default_client_dir())]
    pub client_dir: PathBuf,

    /// Run only the API, for use with the Vite development server.
    #[arg(long, hide = true)]
    pub no_client: bool,

    /// Disable signed update checks and installation.
    #[arg(long, env = "TERM_SERVER_DISABLE_UPDATES", action = ArgAction::SetTrue)]
    pub disable_updates: bool,

    /// Signed release channel to follow.
    #[arg(
        long,
        env = "TERM_SERVER_UPDATE_CHANNEL",
        default_value = "main",
        value_parser = valid_update_channel
    )]
    pub update_channel: String,

    /// Base URL containing signed release channels.
    #[arg(
        long,
        env = "TERM_SERVER_RELEASE_BASE_URL",
        default_value = "https://github.com/Agusx1211/term-server/releases/download"
    )]
    pub release_base_url: String,

    /// Logging filter, for example info or term_server=debug.
    #[arg(
        long,
        env = "TERM_SERVER_LOG",
        default_value = "term_server=info,tower_http=info"
    )]
    pub log: String,
}

impl Cli {
    pub fn is_https(&self) -> bool {
        !self.no_https
    }

    pub fn replay_bytes(&self) -> usize {
        (self.replay_mb * 1024 * 1024) as usize
    }

    pub fn socket_addr(&self) -> Result<std::net::SocketAddr, String> {
        if let Ok(ip) = self.host.parse::<IpAddr>() {
            return Ok(std::net::SocketAddr::new(ip, self.port));
        }
        format!("{}:{}", self.host, self.port)
            .to_socket_addrs()
            .map_err(|error| format!("unable to resolve {}: {error}", self.host))?
            .next()
            .ok_or_else(|| format!("{} did not resolve to an address", self.host))
    }
}

use std::net::ToSocketAddrs;

fn valid_update_channel(value: &str) -> Result<String, String> {
    if crate::update::valid_channel(value) {
        Ok(value.to_owned())
    } else {
        Err(
            "update channel may contain only letters, numbers, dots, underscores, and dashes"
                .into(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_secure_local_binding() {
        let cli = Cli::try_parse_from(["term-server"]).unwrap();
        assert_eq!(cli.host, "127.0.0.1");
        assert_eq!(cli.port, 8090);
        assert!(cli.is_https());
        assert!(cli.tls_hostnames.is_empty());
        assert_eq!(cli.scrollback_lines, 200_000);
        assert_eq!(cli.update_channel, "main");
        assert!(!cli.disable_updates);
    }

    #[test]
    fn accepts_no_https_tls_hostnames_and_resource_limits() {
        let cli = Cli::try_parse_from([
            "term-server",
            "--no-https",
            "--tls-hostname",
            "vscode4,vscode11",
            "--replay-mb",
            "32",
            "--max-panes",
            "2",
        ])
        .unwrap();
        assert!(!cli.is_https());
        assert_eq!(cli.tls_hostnames, ["vscode4", "vscode11"]);
        assert_eq!(cli.replay_bytes(), 32 * 1024 * 1024);
        assert_eq!(cli.max_panes, 2);
    }
}
