use std::io::Read;

use serde::{Deserialize, Serialize};
use serde_json::Value;

const MAX_HOOK_INPUT_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentActivity {
    pub label: String,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentEventKind {
    Thinking,
    RunningCommand,
    EditingFiles,
    Searching,
    Delegating,
    UsingTool,
    WaitingForApproval,
    Compacting,
    Completed,
    Closed,
}

impl AgentEventKind {
    pub fn activity_label(self) -> Option<&'static str> {
        match self {
            Self::Thinking => Some("thinking"),
            Self::RunningCommand => Some("running a command"),
            Self::EditingFiles => Some("editing files"),
            Self::Searching => Some("searching"),
            Self::Delegating => Some("delegating"),
            Self::UsingTool => Some("using a tool"),
            Self::WaitingForApproval => Some("waiting for approval"),
            Self::Compacting => Some("compacting context"),
            Self::Completed | Self::Closed => None,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct AgentEvent {
    pub provider: String,
    pub kind: AgentEventKind,
    /// A provider-supplied conversation title. omp generates one from the
    /// first message and forwards it so term-server reuses it instead of
    /// generating its own; other providers leave this `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

impl AgentEvent {
    pub fn from_hook_input(provider: &str, input: &Value) -> Option<Self> {
        let provider = match provider.trim().to_ascii_lowercase().as_str() {
            "codex" => "codex",
            "claude" => "claude",
            "pi" => "pi",
            "omp" => "omp",
            _ => return None,
        };
        let name = input
            .get("hook_event_name")
            .or_else(|| input.get("event"))
            .and_then(Value::as_str)?;
        let kind = match name {
            "UserPromptSubmit" | "agent_start" | "before_agent_start" | "PostCompact"
            | "session_compact" | "tool_execution_end" | "PostToolUse" | "PostToolUseFailure" => {
                AgentEventKind::Thinking
            }
            "PreToolUse" | "tool_execution_start" => tool_event_kind(
                input
                    .get("tool_name")
                    .or_else(|| input.get("toolName"))
                    .and_then(Value::as_str),
            ),
            "PermissionRequest" | "Notification" => AgentEventKind::WaitingForApproval,
            "PreCompact" | "session_before_compact" => AgentEventKind::Compacting,
            "Stop" | "StopFailure" | "agent_settled" => AgentEventKind::Completed,
            "SessionEnd" | "session_shutdown" => AgentEventKind::Closed,
            _ => return None,
        };
        Some(Self {
            provider: provider.to_owned(),
            kind,
            title: input
                .get("title")
                .and_then(Value::as_str)
                .map(|title| title.trim().to_owned())
                .filter(|title| !title.is_empty()),
        })
    }
}

pub fn read_hook_event(
    provider: &str,
    mut reader: impl std::io::Read,
) -> std::io::Result<Option<AgentEvent>> {
    let mut bytes = Vec::new();
    reader
        .by_ref()
        .take(MAX_HOOK_INPUT_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_HOOK_INPUT_BYTES {
        std::io::copy(&mut reader, &mut std::io::sink())?;
        return Ok(None);
    }
    let Ok(input) = serde_json::from_slice::<Value>(&bytes) else {
        return Ok(None);
    };
    Ok(AgentEvent::from_hook_input(provider, &input))
}

fn tool_event_kind(tool_name: Option<&str>) -> AgentEventKind {
    let Some(tool_name) = tool_name else {
        return AgentEventKind::UsingTool;
    };
    let normalized = tool_name.to_ascii_lowercase();
    if matches!(
        normalized.as_str(),
        "bash" | "exec_command" | "write_stdin" | "shell"
    ) {
        AgentEventKind::RunningCommand
    } else if matches!(
        normalized.as_str(),
        "apply_patch" | "edit" | "write" | "multiedit" | "notebookedit"
    ) {
        AgentEventKind::EditingFiles
    } else if normalized.contains("search")
        || normalized.contains("browser")
        || normalized.starts_with("web__")
    {
        AgentEventKind::Searching
    } else if matches!(
        normalized.as_str(),
        "agent" | "task" | "spawn_agent" | "collaboration.spawn_agent"
    ) {
        AgentEventKind::Delegating
    } else {
        AgentEventKind::UsingTool
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_provider_hook_events_without_payload_details() {
        let event = AgentEvent::from_hook_input(
            "codex",
            &serde_json::json!({
                "hook_event_name": "PreToolUse",
                "tool_name": "Bash",
                "tool_input": { "command": "secret command" }
            }),
        )
        .unwrap();
        assert_eq!(
            event,
            AgentEvent {
                provider: "codex".to_owned(),
                kind: AgentEventKind::RunningCommand,
                title: None,
            }
        );
        assert!(
            !serde_json::to_string(&event)
                .unwrap()
                .contains("secret command")
        );
    }

    #[test]
    fn maps_lifecycle_events_to_shared_activity_kinds() {
        let cases = [
            ("UserPromptSubmit", AgentEventKind::Thinking),
            ("PermissionRequest", AgentEventKind::WaitingForApproval),
            ("PreCompact", AgentEventKind::Compacting),
            ("Stop", AgentEventKind::Completed),
            ("SessionEnd", AgentEventKind::Closed),
            ("agent_settled", AgentEventKind::Completed),
        ];
        for (name, expected) in cases {
            let event = AgentEvent::from_hook_input(
                if name.starts_with("agent_") {
                    "pi"
                } else {
                    "claude"
                },
                &serde_json::json!({ "hook_event_name": name }),
            )
            .unwrap();
            assert_eq!(event.kind, expected);
        }
    }

    #[test]
    fn forwards_omp_lifecycle_and_title() {
        let activity = AgentEvent::from_hook_input(
            "omp",
            &serde_json::json!({ "hook_event_name": "tool_execution_start", "tool_name": "edit" }),
        )
        .unwrap();
        assert_eq!(activity.provider, "omp");
        assert_eq!(activity.kind, AgentEventKind::EditingFiles);
        assert_eq!(activity.title, None);

        let titled = AgentEvent::from_hook_input(
            "OMP",
            &serde_json::json!({
                "hook_event_name": "agent_start",
                "title": "  fix checkout latency  "
            }),
        )
        .unwrap();
        assert_eq!(titled.kind, AgentEventKind::Thinking);
        assert_eq!(titled.title.as_deref(), Some("fix checkout latency"));
        // The title is absent from the wire shape when unset.
        assert!(!serde_json::to_string(&activity).unwrap().contains("title"));
    }

    #[test]
    fn ignores_unknown_providers_events_and_drains_oversized_inputs() {
        assert!(AgentEvent::from_hook_input(
            "other",
            &serde_json::json!({ "hook_event_name": "Stop" }),
        )
        .is_none());
        assert!(
            AgentEvent::from_hook_input(
                "codex",
                &serde_json::json!({ "hook_event_name": "FutureEvent" }),
            )
            .is_none()
        );
        let oversized = vec![b' '; MAX_HOOK_INPUT_BYTES as usize + 1024];
        let mut input = std::io::Cursor::new(oversized);
        assert!(read_hook_event("codex", &mut input).unwrap().is_none());
        assert_eq!(input.position(), input.get_ref().len() as u64);
    }
}
