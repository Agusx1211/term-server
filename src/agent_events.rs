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
}

impl AgentEvent {
    pub fn from_hook_input(provider: &str, input: &Value) -> Option<Self> {
        let provider = match provider.trim().to_ascii_lowercase().as_str() {
            "codex" => "codex",
            "claude" => "claude",
            "pi" => "pi",
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
        })
    }
}

pub fn read_hook_event(
    provider: &str,
    reader: impl std::io::Read,
) -> std::io::Result<Option<AgentEvent>> {
    let mut bytes = Vec::new();
    reader
        .take(MAX_HOOK_INPUT_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_HOOK_INPUT_BYTES {
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
    fn ignores_unknown_providers_events_and_oversized_inputs() {
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
        let oversized = vec![b' '; MAX_HOOK_INPUT_BYTES as usize + 1];
        assert!(
            read_hook_event("codex", oversized.as_slice())
                .unwrap()
                .is_none()
        );
    }
}
