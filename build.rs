use std::{env, process::Command};

fn main() {
    println!("cargo:rerun-if-env-changed=TERM_SERVER_BUILD_COMMIT");
    track_git_identity();

    let commit = env::var("TERM_SERVER_BUILD_COMMIT")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(git_commit)
        .unwrap_or_else(|| "unknown".to_owned());
    println!("cargo:rustc-env=TERM_SERVER_BUILD_COMMIT={commit}");
}

fn git_commit() -> Option<String> {
    git_output(&["rev-parse", "HEAD"])
}

fn track_git_identity() {
    if let Some(head) = git_output(&["rev-parse", "--git-path", "HEAD"]) {
        println!("cargo:rerun-if-changed={head}");
    }
    if let Some(reference) = git_output(&["symbolic-ref", "-q", "HEAD"])
        && let Some(path) = git_output(&["rev-parse", "--git-path", &reference])
    {
        println!("cargo:rerun-if-changed={path}");
    }
}

fn git_output(arguments: &[&str]) -> Option<String> {
    let output = Command::new("git").args(arguments).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .filter(|value| !value.is_empty())
}
