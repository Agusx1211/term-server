#[cfg(unix)]
use std::time::Duration;
use std::{
    env,
    ffi::OsString,
    net::SocketAddr,
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
};

use axum_server::Handle;
use clap::Parser;
#[cfg(unix)]
use term_server::broker::{BrokerClient, BrokerPool, legacy_socket_path, run_session_broker};
#[cfg(unix)]
use term_server::supervisor::{self, SupervisorControlSocket, SupervisorService};
#[cfg(unix)]
use term_server::{access_cli, config::CliCommand};
use term_server::{
    activity_view::ActivityViewService,
    agent_events::read_hook_event,
    agent_integrations::AgentIntegrationService,
    api::{AppState, ServerControl, build_router},
    artifact_skill::ArtifactSkillService,
    auth::{LoginLimiter, load_auth},
    config::Cli,
    debug_recording::DebugRecordingManager,
    pushover::PushoverService,
    status::StatusService,
    tls::load_tls,
    update::UpdateService,
    workspace::WorkspaceBackend,
};
#[cfg(not(unix))]
use term_server::{ai::PiService, terminal::TerminalManager};
use tracing_subscriber::EnvFilter;

#[cfg(unix)]
const AGENT_EVENT_FORWARD_TIMEOUT: Duration = Duration::from_millis(500);

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(unix)]
    if supervisor::is_client_invocation() {
        return supervisor::run_client().await.map_err(Into::into);
    }
    let cli = Cli::parse();
    #[cfg(unix)]
    if let Some(CliCommand::Access(command)) = cli.command.clone() {
        std::process::exit(access_cli::run(command).await);
    }
    let executable = env::current_exe()?;
    if let Some(provider) = cli.agent_event.as_deref() {
        #[cfg(unix)]
        forward_agent_event(provider).await;
        return Ok(());
    }
    let restart_arguments = env::args_os().skip(1).collect::<Vec<_>>();
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_new(&cli.log)?)
        .compact()
        .init();

    if cli.session_broker {
        #[cfg(unix)]
        {
            let socket = cli
                .broker_socket
                .clone()
                .unwrap_or_else(|| legacy_socket_path(&cli.data_dir));
            return run_session_broker(
                &cli.data_dir,
                &socket,
                cli.shell.clone(),
                cli.replay_bytes(),
                env::var("TERM_SERVER_BROKER_CONTROL_TOKEN").ok(),
            )
            .await;
        }
        #[cfg(not(unix))]
        return Err("the terminal session broker requires Unix sockets".into());
    }

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

    // Claiming the supervisor control socket is what makes this process the
    // single server for its data directory. It happens before the workspace is
    // opened so a second server cannot reconfigure the running server's session
    // broker on its way to being rejected.
    #[cfg(unix)]
    let control_socket = SupervisorControlSocket::claim(&cli.data_dir).await?;
    let loaded_auth = load_auth(
        &cli.data_dir,
        env::var("TERM_SERVER_PASSWORD").ok(),
        cli.password_file.as_ref(),
    )
    .await?;
    let status_modules = Arc::new(StatusService::new(
        cli.status_config.as_deref(),
        &cli.data_dir,
        !cli.no_status_auto,
    )?);
    let tls = load_tls(&cli).await?;
    let address = cli.socket_addr()?;
    let workspace = load_workspace(&cli, &executable).await?;
    #[cfg(unix)]
    let supervisor = SupervisorService::new(workspace.clone(), &cli.data_dir, &executable).await?;
    #[cfg(unix)]
    supervisor.serve(control_socket);
    let updates = Arc::new(UpdateService::new(
        client_directory.as_deref(),
        cli.update_channel.clone(),
        cli.release_base_url.clone(),
        cli.disable_updates,
        &cli.data_dir,
    ));
    let handle = Handle::new();
    let server_control = ServerControl::new(handle.clone());
    let hostname = env::var("HOSTNAME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok())
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "unknown".to_owned());
    let state = AppState {
        auth: loaded_auth.service,
        workspace: workspace.clone(),
        #[cfg(unix)]
        supervisor,
        login_limiter: Arc::new(LoginLimiter::default()),
        allowed_origins: cli.allowed_origins.clone().into(),
        secure: cli.is_https(),
        secure_cookie: cli.secure_cookie,
        scrollback_lines: cli.scrollback_lines,
        max_panes: cli.max_panes,
        cached_terminals: cli.cached_terminals,
        hostname,
        updates,
        agent_integrations: Arc::new(AgentIntegrationService::new(&cli.data_dir)),
        activity_views: ActivityViewService::new(&cli.data_dir),
        artifact_skill: Arc::new(ArtifactSkillService::discover()),
        server_control: server_control.clone(),
        debug_recording: Arc::new(DebugRecordingManager::new()),
        pushover: Arc::new(PushoverService::new(&cli.data_dir)),
        status_modules,
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
    let serve_result = if let Some(tls) = tls {
        axum_server::bind_rustls(address, tls)
            .handle(handle)
            .serve(service)
            .await
    } else {
        axum_server::bind(address)
            .handle(handle)
            .serve(service)
            .await
    };
    let restarting = server_control.restart_requested() && serve_result.is_ok();
    let restarting_broker = restarting && server_control.broker_restart_requested();
    if !restarting || restarting_broker {
        tracing::info!("shutting down terminal sessions");
        workspace.shutdown().await;
    }
    serve_result?;
    if restarting {
        restart_process(&executable, &restart_arguments)?;
    }
    Ok(())
}

#[cfg(unix)]
async fn forward_agent_event(provider: &str) {
    let Some(socket) = env::var_os("TERM_SERVER_BROKER_SOCKET").map(PathBuf::from) else {
        return;
    };
    let Some(id) = env::var("TERM_SERVER_SESSION")
        .ok()
        .and_then(|value| uuid::Uuid::parse_str(&value).ok())
    else {
        return;
    };
    let Ok(Some(event)) = read_hook_event(provider, std::io::stdin().lock()) else {
        return;
    };
    let client = BrokerClient::new(socket);
    let _ = tokio::time::timeout(AGENT_EVENT_FORWARD_TIMEOUT, client.agent_event(id, &event)).await;
}

#[cfg(unix)]
async fn load_workspace(
    cli: &Cli,
    executable: &Path,
) -> Result<WorkspaceBackend, Box<dyn std::error::Error>> {
    Ok(WorkspaceBackend::broker(
        BrokerPool::connect_or_start(cli, executable).await?,
    ))
}

#[cfg(not(unix))]
async fn load_workspace(
    cli: &Cli,
    _executable: &Path,
) -> Result<WorkspaceBackend, Box<dyn std::error::Error>> {
    let terminals = Arc::new(TerminalManager::new(cli.shell.clone(), cli.replay_bytes()));
    let pi = Arc::new(PiService::new(&cli.data_dir));
    terminals.start_monitor(pi.clone());
    Ok(WorkspaceBackend::local(terminals, pi))
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

    tracing::info!("shutting down web server");
    server_control.shutdown();
}

#[cfg(unix)]
fn restart_process(executable: &Path, arguments: &[OsString]) -> std::io::Result<()> {
    use std::os::unix::process::CommandExt;

    tracing::info!("restarting term-server process");
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
