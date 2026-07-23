use std::{env, ffi::OsString, net::SocketAddr, path::Path, process::Command, sync::Arc};

use axum_server::Handle;
use clap::Parser;
use term_server::{
    ai::PiService,
    api::{AppState, ServerControl, build_router},
    auth::{LoginLimiter, load_auth},
    config::Cli,
    terminal::TerminalManager,
    tls::load_tls,
    update::UpdateService,
};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    let executable = env::current_exe()?;
    let restart_arguments = env::args_os().skip(1).collect::<Vec<_>>();
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
    let updates = Arc::new(UpdateService::new(
        client_directory.as_deref(),
        cli.update_channel.clone(),
        cli.release_base_url.clone(),
        cli.disable_updates,
    ));
    let handle = Handle::new();
    let server_control = ServerControl::new(handle.clone(), terminals.clone());
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
        updates,
        server_control: server_control.clone(),
    };
    let app = build_router(state, client_directory);
    tokio::spawn(shutdown_signal(server_control.clone()));

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
    if server_control.restart_requested() {
        restart_process(&executable, &restart_arguments)?;
    }
    Ok(())
}

async fn shutdown_signal(server_control: ServerControl) {
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
    server_control.shutdown(false);
}

#[cfg(unix)]
fn restart_process(executable: &Path, arguments: &[OsString]) -> std::io::Result<()> {
    use std::os::unix::process::CommandExt;

    tracing::info!("restarting into the installed update");
    let error = Command::new(executable).args(arguments).exec();
    Err(error)
}

#[cfg(not(unix))]
fn restart_process(_executable: &Path, _arguments: &[OsString]) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "automatic restart is unsupported on this platform",
    ))
}
