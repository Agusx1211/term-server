use std::{env, path::PathBuf};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use clap::{Args, Subcommand, ValueEnum};
use http_body_util::BodyExt;
use tokio::io::{AsyncWriteExt, stdout};
use uuid::Uuid;

use crate::{
    access::{
        AgentAccessEvent, AgentRequestContext, AgentSecretExecute, AgentSecretGenerate,
        AgentSecretName, AgentSecretRequest, AgentSecretShare, AgentSecretShareId,
        AgentSudoRequest, DEFAULT_GENERATED_SECRET_CHARS, GeneratedSecretCharset, SecretDelivery,
        current_process_start_ticks,
    },
    broker::BrokerClient,
};

const BROKER_SOCKET_ENV: &str = "TERM_SERVER_BROKER_SOCKET";
const TERMINAL_SESSION_ENV: &str = "TERM_SERVER_SESSION";

#[derive(Debug, Clone, Args)]
pub struct AccessCli {
    #[command(subcommand)]
    command: AccessCliCommand,
}

#[derive(Debug, Clone, Subcommand)]
enum AccessCliCommand {
    /// Request, use, list, or revoke secrets for this terminal.
    Secret(SecretCli),
    /// Ask the user to review and run one exact local command through sudo.
    Sudo(SudoCli),
}

#[derive(Debug, Clone, Args)]
struct SecretCli {
    #[command(subcommand)]
    command: SecretCliCommand,
}

#[derive(Debug, Clone, Subcommand)]
enum SecretCliCommand {
    /// Request a named secret and wait for the user's decision.
    Request(SecretRequestCli),
    /// List secret grants available to this terminal; values are never shown.
    List(AgentCli),
    /// Run a command with a granted secret injected by the broker.
    Run(SecretRunCli),
    /// Revoke a named secret grant from this terminal.
    Drop(SecretDropCli),
    /// Generate a random secret inside the broker and grant it here without ever seeing it.
    Generate(SecretGenerateCli),
    /// Offer a granted secret to the user for a single reveal in the Access panel.
    Share(SecretShareCli),
    /// Report whether the user viewed, dismissed, or let a shared secret expire.
    ShareStatus(SecretShareStatusCli),
    /// List secrets shared with the user from this terminal; values are never shown.
    ShareList(AgentCli),
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum SecretCharsetArg {
    /// ASCII letters and digits.
    Alnum,
    /// Letters, digits, and shell-safe punctuation.
    Ascii,
    /// Lowercase hexadecimal.
    Hex,
    /// Decimal digits only.
    Digits,
}

impl From<SecretCharsetArg> for GeneratedSecretCharset {
    fn from(value: SecretCharsetArg) -> Self {
        match value {
            SecretCharsetArg::Alnum => Self::Alnum,
            SecretCharsetArg::Ascii => Self::Ascii,
            SecretCharsetArg::Hex => Self::Hex,
            SecretCharsetArg::Digits => Self::Digits,
        }
    }
}

#[derive(Debug, Clone, Args)]
struct SecretGenerateCli {
    /// Stable environment-style secret name.
    #[arg(long)]
    name: String,
    /// What the generated value is for, shown to the user.
    #[arg(long)]
    description: Option<String>,
    /// Number of characters to generate (8-256).
    #[arg(long, default_value_t = DEFAULT_GENERATED_SECRET_CHARS)]
    length: usize,
    /// Alphabet to draw characters from.
    #[arg(long, value_enum, default_value_t = SecretCharsetArg::Alnum)]
    charset: SecretCharsetArg,
    /// Replace an existing grant of the same name instead of failing.
    #[arg(long)]
    replace: bool,
    /// Also offer the new value to the user for a single reveal and wait for the outcome.
    #[arg(long)]
    share: bool,
    /// With --share, print the share id and return instead of waiting.
    #[arg(long, requires = "share")]
    no_wait: bool,
    /// Agent generating the secret, for attribution in the browser.
    #[arg(long, default_value = "agent")]
    agent: String,
}

#[derive(Debug, Clone, Args)]
struct SecretShareCli {
    /// Granted secret name.
    #[arg(long)]
    name: String,
    /// Why the user should receive this value, shown next to it.
    #[arg(long)]
    description: Option<String>,
    /// Print the share id and return instead of waiting for the user.
    #[arg(long)]
    no_wait: bool,
    /// Agent sharing the secret, for attribution in the browser.
    #[arg(long, default_value = "agent")]
    agent: String,
}

#[derive(Debug, Clone, Args)]
struct SecretShareStatusCli {
    /// Share id printed by `share --no-wait` or `share-list`.
    #[arg(long)]
    id: Uuid,
    /// Block until the user views or dismisses the share, or it expires.
    #[arg(long)]
    wait: bool,
    /// Agent checking the share, for process attribution.
    #[arg(long, default_value = "agent")]
    agent: String,
}

#[derive(Debug, Clone, Args)]
struct AgentCli {
    /// Agent requesting access, for attribution in the browser.
    #[arg(long, default_value = "agent")]
    agent: String,
}

#[derive(Debug, Clone, Args)]
struct SecretRequestCli {
    /// Stable environment-style secret name.
    #[arg(long)]
    name: String,
    /// Exact purpose the user is authorizing.
    #[arg(long)]
    description: String,
    /// Agent requesting access, for attribution in the browser.
    #[arg(long, default_value = "agent")]
    agent: String,
}

#[derive(Debug, Clone, Args)]
struct SecretRunCli {
    /// Granted secret name.
    #[arg(long)]
    name: String,
    /// Inject the secret into this environment variable.
    #[arg(long, conflicts_with = "stdin", required_unless_present = "stdin")]
    env: Option<String>,
    /// Write the secret to the command's standard input, then close it.
    #[arg(long, conflicts_with = "env", required_unless_present = "env")]
    stdin: bool,
    /// Agent using access, for process attribution.
    #[arg(long, default_value = "agent")]
    agent: String,
    /// Exact command and arguments. No shell interpretation is performed.
    #[arg(last = true, required = true)]
    command: Vec<String>,
}

#[derive(Debug, Clone, Args)]
struct SecretDropCli {
    /// Granted secret name.
    #[arg(long)]
    name: String,
    /// Agent revoking access, for process attribution.
    #[arg(long, default_value = "agent")]
    agent: String,
}

#[derive(Debug, Clone, Args)]
struct SudoCli {
    /// Exact local effect, scope, and reason for the command.
    #[arg(long)]
    description: String,
    /// Agent requesting access, for attribution in the browser.
    #[arg(long, default_value = "agent")]
    agent: String,
    /// Exact command and arguments. Do not include a leading sudo.
    #[arg(last = true, required = true)]
    command: Vec<String>,
}

pub async fn run(command: AccessCli) -> i32 {
    match run_inner(command).await {
        Ok(code) => code,
        Err(error) => {
            eprintln!("term-server access: {error}");
            125
        }
    }
}

async fn run_inner(command: AccessCli) -> Result<i32, Box<dyn std::error::Error>> {
    let socket = env::var_os(BROKER_SOCKET_ENV)
        .map(PathBuf::from)
        .ok_or("this command must run inside a term-server terminal")?;
    let terminal_id = env::var(TERMINAL_SESSION_ENV)
        .map_err(|_| "this command must run inside a term-server terminal")?
        .parse::<Uuid>()?;
    let client = BrokerClient::new(socket);
    match command.command {
        AccessCliCommand::Secret(secret) => match secret.command {
            SecretCliCommand::Request(request) => {
                let context = context(request.agent)?;
                let body = client
                    .agent_secret_request(
                        terminal_id,
                        &AgentSecretRequest {
                            context,
                            name: request.name,
                            description: request.description,
                        },
                    )
                    .await?;
                consume_events(body).await
            }
            SecretCliCommand::List(agent) => {
                let grants = client
                    .agent_secret_list(terminal_id, &context(agent.agent)?)
                    .await?;
                for grant in grants {
                    println!(
                        "{}\tuses={}\tlast_command={}",
                        grant.name,
                        grant.uses,
                        grant.last_command.as_deref().unwrap_or("-")
                    );
                }
                Ok(0)
            }
            SecretCliCommand::Run(request) => {
                let delivery = if request.stdin {
                    SecretDelivery::Stdin
                } else {
                    SecretDelivery::Env {
                        name: request.env.expect("clap requires --env or --stdin"),
                    }
                };
                let body = client
                    .agent_secret_execute(
                        terminal_id,
                        &AgentSecretExecute {
                            context: context(request.agent)?,
                            name: request.name,
                            cwd: env::current_dir()?,
                            command: resolve_command(request.command)?,
                            delivery,
                        },
                    )
                    .await?;
                consume_events(body).await
            }
            SecretCliCommand::Drop(request) => {
                client
                    .agent_secret_drop(
                        terminal_id,
                        &AgentSecretName {
                            context: context(request.agent)?,
                            name: request.name,
                        },
                    )
                    .await?;
                Ok(0)
            }
            SecretCliCommand::Generate(request) => {
                let grant = client
                    .agent_secret_generate(
                        terminal_id,
                        &AgentSecretGenerate {
                            context: context(request.agent.clone())?,
                            name: request.name.clone(),
                            description: request.description.clone(),
                            length: Some(request.length),
                            charset: request.charset.into(),
                            replace: request.replace,
                        },
                    )
                    .await?;
                eprintln!(
                    "Secret {} generated and granted to this terminal; its value was never returned.",
                    grant.name
                );
                if !request.share {
                    return Ok(0);
                }
                let body = client
                    .agent_secret_share(
                        terminal_id,
                        &AgentSecretShare {
                            context: context(request.agent)?,
                            name: request.name,
                            description: request.description,
                        },
                    )
                    .await?;
                consume_share_events(body, request.no_wait).await
            }
            SecretCliCommand::Share(request) => {
                let body = client
                    .agent_secret_share(
                        terminal_id,
                        &AgentSecretShare {
                            context: context(request.agent)?,
                            name: request.name,
                            description: request.description,
                        },
                    )
                    .await?;
                consume_share_events(body, request.no_wait).await
            }
            SecretCliCommand::ShareStatus(request) => {
                let context = context(request.agent)?;
                if request.wait {
                    let body = client
                        .agent_secret_share_wait(
                            terminal_id,
                            &AgentSecretShareId {
                                context,
                                id: request.id,
                            },
                        )
                        .await?;
                    return consume_share_events(body, false).await;
                }
                let shares = client
                    .agent_secret_share_list(terminal_id, &context)
                    .await?;
                let share = shares
                    .into_iter()
                    .find(|share| share.id == request.id)
                    .ok_or("shared secret not found; it may have been cleared")?;
                println!(
                    "{}\t{}\t{}",
                    share_state_label(share.state),
                    share.id,
                    share.name
                );
                Ok(0)
            }
            SecretCliCommand::ShareList(agent) => {
                let shares = client
                    .agent_secret_share_list(terminal_id, &context(agent.agent)?)
                    .await?;
                for share in shares {
                    println!(
                        "{}\t{}\t{}\twaiters={}\texpires_at={}",
                        share_state_label(share.state),
                        share.id,
                        share.name,
                        share.waiters,
                        share.expires_at
                    );
                }
                Ok(0)
            }
        },
        AccessCliCommand::Sudo(request) => {
            let body = client
                .agent_sudo_request(
                    terminal_id,
                    &AgentSudoRequest {
                        context: context(request.agent)?,
                        description: request.description,
                        cwd: env::current_dir()?,
                        command: resolve_command(request.command)?,
                    },
                )
                .await?;
            consume_events(body).await
        }
    }
}

fn share_state_label(state: crate::access::SecretShareState) -> &'static str {
    match state {
        crate::access::SecretShareState::Pending => "pending",
        crate::access::SecretShareState::Viewed => "viewed",
        crate::access::SecretShareState::Dismissed => "dismissed",
        crate::access::SecretShareState::Expired => "expired",
    }
}

/// Follows a share stream. The outcome word goes to stdout so an agent can
/// read it, and the exit code mirrors the request convention: 0 when the user
/// revealed the value, 126 when they dismissed it or let it expire.
async fn consume_share_events(
    mut body: hyper::body::Incoming,
    return_on_waiting: bool,
) -> Result<i32, Box<dyn std::error::Error>> {
    let mut pending = Vec::new();
    while let Some(frame) = body.frame().await {
        let frame = frame?;
        let Ok(data) = frame.into_data() else {
            continue;
        };
        pending.extend_from_slice(&data);
        while let Some(end) = pending.iter().position(|byte| *byte == b'\n') {
            let line = pending.drain(..=end).collect::<Vec<_>>();
            if line.len() == 1 {
                continue;
            }
            let event: AgentAccessEvent = serde_json::from_slice(&line[..line.len() - 1])?;
            match event {
                AgentAccessEvent::Waiting { request_id } => {
                    if return_on_waiting {
                        eprintln!(
                            "Shared secret {request_id} is waiting for the user in term-server."
                        );
                        println!("{request_id}");
                        return Ok(0);
                    }
                    eprintln!("Shared secret {request_id} is waiting for the user in term-server.");
                }
                AgentAccessEvent::Viewed { name } => {
                    eprintln!("The user revealed {name}.");
                    println!("viewed");
                    return Ok(0);
                }
                AgentAccessEvent::Dismissed { name } => {
                    eprintln!("The user dismissed {name} without viewing it.");
                    println!("dismissed");
                    return Ok(126);
                }
                AgentAccessEvent::Expired { name } => {
                    eprintln!("{name} expired before the user viewed it.");
                    println!("expired");
                    return Ok(126);
                }
                AgentAccessEvent::Failed { message } => {
                    eprintln!("Sharing failed: {message}");
                    return Ok(125);
                }
                AgentAccessEvent::Running { .. }
                | AgentAccessEvent::Output { .. }
                | AgentAccessEvent::Granted { .. }
                | AgentAccessEvent::Rejected { .. }
                | AgentAccessEvent::Completed { .. } => {}
            }
        }
    }
    Err("share stream ended without a final result".into())
}

fn resolve_command(mut command: Vec<String>) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let executable = command
        .first()
        .ok_or("command is required")
        .map(PathBuf::from)?;
    let resolved = if executable.components().count() > 1 {
        executable.canonicalize()?
    } else {
        let path = env::var_os("PATH").ok_or("PATH is unavailable")?;
        env::split_paths(&path)
            .map(|directory| directory.join(&executable))
            .find(|candidate| candidate.is_file())
            .ok_or_else(|| format!("command not found: {}", executable.display()))?
            .canonicalize()?
    };
    if !resolved.is_file() {
        return Err(format!("command is not a regular file: {}", resolved.display()).into());
    }
    command[0] = resolved
        .into_os_string()
        .into_string()
        .map_err(|_| "command path is not valid UTF-8")?;
    Ok(command)
}
fn context(agent: String) -> Result<AgentRequestContext, Box<dyn std::error::Error>> {
    Ok(AgentRequestContext {
        pid: std::process::id(),
        start_ticks: current_process_start_ticks()?,
        agent,
    })
}

async fn consume_events(
    mut body: hyper::body::Incoming,
) -> Result<i32, Box<dyn std::error::Error>> {
    let mut pending = Vec::new();
    while let Some(frame) = body.frame().await {
        let frame = frame?;
        let Ok(data) = frame.into_data() else {
            continue;
        };
        pending.extend_from_slice(&data);
        while let Some(end) = pending.iter().position(|byte| *byte == b'\n') {
            let line = pending.drain(..=end).collect::<Vec<_>>();
            if line.len() == 1 {
                continue;
            }
            let event: AgentAccessEvent = serde_json::from_slice(&line[..line.len() - 1])?;
            match event {
                AgentAccessEvent::Waiting { request_id } => {
                    eprintln!("Access request {request_id} is waiting in term-server.");
                }
                AgentAccessEvent::Running { .. } => {
                    eprintln!("Access approved; command is running.");
                }
                AgentAccessEvent::Output { data } => {
                    let bytes = BASE64.decode(data)?;
                    let mut output = stdout();
                    output.write_all(&bytes).await?;
                    output.flush().await?;
                }
                AgentAccessEvent::Granted { name } => {
                    eprintln!("Secret {name} is available to this terminal.");
                    return Ok(0);
                }
                AgentAccessEvent::Rejected { comment } => {
                    if let Some(comment) = comment {
                        eprintln!("Access rejected: {comment}");
                    } else {
                        eprintln!("Access rejected.");
                    }
                    return Ok(126);
                }
                AgentAccessEvent::Completed { return_code } => return Ok(return_code),
                AgentAccessEvent::Failed { message } => {
                    eprintln!("Access failed: {message}");
                    return Ok(125);
                }
                AgentAccessEvent::Viewed { .. }
                | AgentAccessEvent::Dismissed { .. }
                | AgentAccessEvent::Expired { .. } => {
                    return Err("unexpected share outcome on an access stream".into());
                }
            }
        }
    }
    Err("access stream ended without a final result".into())
}

#[cfg(test)]
mod tests {
    use clap::Parser;

    use super::*;

    #[derive(Parser)]
    struct TestCli {
        #[command(subcommand)]
        command: TestCommand,
    }

    #[derive(Subcommand)]
    enum TestCommand {
        Access(AccessCli),
    }

    #[test]
    fn parses_secret_and_sudo_commands_without_a_shell() {
        let secret = TestCli::try_parse_from([
            "term-server",
            "access",
            "secret",
            "run",
            "--name",
            "TOKEN",
            "--env",
            "TOKEN",
            "--",
            "printf",
            "%s",
        ]);
        assert!(secret.is_ok());
        let sudo = TestCli::try_parse_from([
            "term-server",
            "access",
            "sudo",
            "--description",
            "Install one package",
            "--",
            "apt-get",
            "install",
            "-y",
            "demo",
        ]);
        assert!(sudo.is_ok());
    }

    #[test]
    fn parses_generate_and_share_commands() {
        let generate = TestCli::try_parse_from([
            "term-server",
            "access",
            "secret",
            "generate",
            "--name",
            "DB_PASSWORD",
            "--description",
            "Postgres role for the app",
            "--length",
            "40",
            "--charset",
            "ascii",
            "--share",
            "--no-wait",
            "--agent",
            "omp",
        ]);
        assert!(generate.is_ok(), "{:?}", generate.err());
        let no_wait_without_share = TestCli::try_parse_from([
            "term-server",
            "access",
            "secret",
            "generate",
            "--name",
            "DB_PASSWORD",
            "--no-wait",
        ]);
        assert!(no_wait_without_share.is_err());
        let share = TestCli::try_parse_from([
            "term-server",
            "access",
            "secret",
            "share",
            "--name",
            "DB_PASSWORD",
            "--no-wait",
        ]);
        assert!(share.is_ok());
        let status = TestCli::try_parse_from([
            "term-server",
            "access",
            "secret",
            "share-status",
            "--id",
            "8b7d5f8e-4c2a-4c1a-9b6e-1d2f3a4b5c6d",
            "--wait",
        ]);
        assert!(status.is_ok());
        let list = TestCli::try_parse_from(["term-server", "access", "secret", "share-list"]);
        assert!(list.is_ok());
    }
}
