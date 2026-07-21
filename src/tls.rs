use std::path::{Path, PathBuf};

use axum_server::tls_rustls::RustlsConfig;
use rcgen::{CertifiedKey, generate_simple_self_signed};
use thiserror::Error;
use tokio::fs;

use crate::config::Cli;

#[derive(Debug, Error)]
pub enum TlsError {
    #[error("unable to generate a self-signed certificate: {0}")]
    Generate(#[from] rcgen::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

async fn write_private(path: &Path, contents: &[u8]) -> Result<(), std::io::Error> {
    fs::write(path, contents).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).await?;
    }
    Ok(())
}

async fn generated_paths(data_dir: &Path, host: &str) -> Result<(PathBuf, PathBuf), TlsError> {
    let directory = data_dir.join("tls");
    let cert_path = directory.join("cert.pem");
    let key_path = directory.join("key.pem");
    if fs::try_exists(&cert_path).await? && fs::try_exists(&key_path).await? {
        return Ok((cert_path, key_path));
    }

    fs::create_dir_all(&directory).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).await?;
    }

    let mut names = vec![
        "localhost".to_owned(),
        "127.0.0.1".to_owned(),
        "::1".to_owned(),
    ];
    if !["0.0.0.0", "::", "127.0.0.1", "localhost"].contains(&host) {
        names.push(host.to_owned());
    }
    let CertifiedKey { cert, signing_key } = generate_simple_self_signed(names)?;
    fs::write(&cert_path, cert.pem()).await?;
    write_private(&key_path, signing_key.serialize_pem().as_bytes()).await?;
    Ok((cert_path, key_path))
}

pub async fn load_tls(cli: &Cli) -> Result<Option<RustlsConfig>, TlsError> {
    if !cli.is_https() {
        return Ok(None);
    }
    let (cert_path, key_path) = match (&cli.cert, &cli.cert_key) {
        (Some(cert), Some(key)) => (cert.clone(), key.clone()),
        _ => generated_paths(&cli.data_dir, &cli.host).await?,
    };
    Ok(Some(
        RustlsConfig::from_pem_file(cert_path, key_path).await?,
    ))
}

#[cfg(test)]
mod tests {
    use clap::Parser;

    use super::*;

    #[tokio::test]
    async fn generates_and_reuses_tls_material() {
        let directory = tempfile::tempdir().unwrap();
        let cli = Cli::try_parse_from([
            "term-server",
            "--data-dir",
            directory.path().to_str().unwrap(),
        ])
        .unwrap();
        assert!(load_tls(&cli).await.unwrap().is_some());
        let first = fs::read(directory.path().join("tls/cert.pem"))
            .await
            .unwrap();
        assert!(load_tls(&cli).await.unwrap().is_some());
        let second = fs::read(directory.path().join("tls/cert.pem"))
            .await
            .unwrap();
        assert_eq!(first, second);
    }
}
