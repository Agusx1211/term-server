use std::{env, net::SocketAddr, sync::Arc, time::Duration};

use axum_server::Handle;
use clap::Parser;
use term_server::{
    ai::PiService,
    api::{AppState, build_router},
    auth::{LoginLimiter, load_auth},
    config::Cli,
    terminal::TerminalManager,
    tls::load_tls,
};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_new(&cli.log)?)
        .compact()
        .init();

    let client_directory = if cli.no_client {
        None
    } else {
        let directory = cli.client_dir.canonicalize().map_err(|error| {
            format!(
                "browser build not found at {} ({error}); run `npm run build:client` or set --client-dir",
                cli.client_dir.display()
            )
        })?;
        if !directory.join("index.html").is_file() {
            return Err(format!("{} does not contain index.html", directory.display()).into());
        }
        Some(directory)
    };

    let loaded_auth = load_auth(
        &cli.data_dir,
        env::var("TERM_SERVER_PASSWORD").ok(),
        cli.password_file.as_ref(),
    )
    .await?;
    let tls = load_tls(&cli).await?;
    let address = cli.socket_addr()?;
    let terminals = Arc::new(TerminalManager::new(cli.shell.clone(), cli.replay_bytes()));
    let pi = Arc::new(PiService::new(&cli.data_dir));
    terminals.start_monitor(pi.clone());
    let hostname = env::var("HOSTNAME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok())
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "unknown".to_owned());
    let state = AppState {
        auth: loaded_auth.service,
        terminals: terminals.clone(),
        pi,
        login_limiter: Arc::new(LoginLimiter::default()),
        allowed_origins: cli.allowed_origins.clone().into(),
        secure: cli.is_https(),
        secure_cookie: cli.secure_cookie,
        scrollback_lines: cli.scrollback_lines,
        max_panes: cli.max_panes,
        hostname,
    };
    let app = build_router(state, client_directory);
    let handle = Handle::new();
    tokio::spawn(shutdown_signal(handle.clone(), terminals));

    let scheme = if cli.is_https() { "https" } else { "http" };
    tracing::info!(url = %format!("{scheme}://{address}"), "term-server is ready");
    if let Some(password) = loaded_auth.generated_password {
        tracing::warn!("Generated initial password: {password}");
        tracing::warn!(
            "Save it now. Only its Argon2 hash is stored, so it will not be shown again."
        );
    }

    let service = app.into_make_service_with_connect_info::<SocketAddr>();
    if let Some(tls) = tls {
        axum_server::bind_rustls(address, tls)
            .handle(handle)
            .serve(service)
            .await?;
    } else {
        axum_server::bind(address)
            .handle(handle)
            .serve(service)
            .await?;
    }
    Ok(())
}

async fn shutdown_signal(handle: Handle<SocketAddr>, terminals: Arc<TerminalManager>) {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = terminate.recv() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;

    tracing::info!("shutting down terminal sessions");
    terminals.shutdown();
    handle.graceful_shutdown(Some(Duration::from_secs(5)));
}
