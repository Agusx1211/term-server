use std::io::Read;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::history::{AgentTranscriptInput, AgentTranscriptKind};

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence: Option<u64>,
    /// A provider-supplied conversation title. omp generates one from the
    /// first message and forwards it so term-server reuses it instead of
    /// generating its own; other providers leave this `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub transcript_only: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub transcript_reset: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub transcript: Vec<AgentTranscriptInput>,
}

impl AgentEvent {
    pub fn from_hook_input(provider: &str, input: &Value) -> Option<Self> {
        let provider = match provider.trim().to_ascii_lowercase().as_str() {
            "codex" => "codex",
            "claude" => "claude",
            "pi" => "pi",
            "omp" => "omp",
            "hermes" => "hermes",
            _ => return None,
        };
        let name = input
            .get("hook_event_name")
            .or_else(|| input.get("event"))
            .and_then(Value::as_str)?;
        let transcript_only = matches!(name, "transcript_snapshot" | "message_end");
        let kind = match name {
            "UserPromptSubmit"
            | "agent_start"
            | "before_agent_start"
            | "PostCompact"
            | "session_compact"
            | "tool_execution_end"
            | "PostToolUse"
            | "PostToolUseFailure"
            | "transcript_snapshot"
            | "message_end" => AgentEventKind::Thinking,
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
        let sequence = input.get("sequence").and_then(Value::as_u64);
        let mut transcript = input
            .get("transcript")
            .cloned()
            .and_then(|value| serde_json::from_value::<Vec<AgentTranscriptInput>>(value).ok())
            .unwrap_or_default();
        if !transcript_only {
            transcript.extend(hook_transcript_entries(name, input, sequence));
            transcript.push(AgentTranscriptInput {
                kind: AgentTranscriptKind::Status,
                source_id: sequence.map(|sequence| format!("status:{sequence}")),
                timestamp: input.get("timestamp").and_then(Value::as_u64),
                role: None,
                name: Some(name.to_owned()),
                text: Some(agent_event_status(kind).to_owned()),
                data: None,
                truncated: false,
            });
        }
        Some(Self {
            provider: provider.to_owned(),
            kind,
            sequence,
            title: input
                .get("title")
                .and_then(Value::as_str)
                .map(|title| title.trim().to_owned())
                .filter(|title| !title.is_empty()),
            transcript_only,
            transcript_reset: input
                .get("transcriptReset")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            transcript,
        })
    }
}

fn hook_transcript_entries(
    event: &str,
    input: &Value,
    sequence: Option<u64>,
) -> Vec<AgentTranscriptInput> {
    let source = |prefix: &str| {
        input
            .get("tool_use_id")
            .or_else(|| input.get("toolCallId"))
            .or_else(|| input.get("event_id"))
            .and_then(Value::as_str)
            .map(|id| format!("{prefix}:{id}"))
            .or_else(|| sequence.map(|sequence| format!("{prefix}:{sequence}")))
    };
    let timestamp = input.get("timestamp").and_then(Value::as_u64);
    let tool_name = input
        .get("tool_name")
        .or_else(|| input.get("toolName"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let record = match event {
        "UserPromptSubmit" | "before_agent_start" => input
            .get("prompt")
            .and_then(Value::as_str)
            .map(|prompt| AgentTranscriptInput {
                kind: AgentTranscriptKind::Message,
                source_id: source("message"),
                timestamp,
                role: Some("user".to_owned()),
                name: None,
                text: Some(prompt.to_owned()),
                data: None,
                truncated: false,
            }),
        "PreToolUse" | "tool_execution_start" => {
            let data = input
                .get("tool_input")
                .or_else(|| input.get("args"))
                .cloned();
            Some(AgentTranscriptInput {
                kind: AgentTranscriptKind::ToolStart,
                source_id: source("tool-start"),
                timestamp,
                role: None,
                name: tool_name,
                text: data.as_ref().and_then(semantic_text),
                data,
                truncated: false,
            })
        }
        "PostToolUse" | "PostToolUseFailure" | "tool_execution_end" => {
            let data = input
                .get("tool_response")
                .or_else(|| input.get("tool_output"))
                .or_else(|| input.get("result"))
                .cloned();
            Some(AgentTranscriptInput {
                kind: AgentTranscriptKind::ToolResult,
                source_id: source("tool-result"),
                timestamp,
                role: None,
                name: tool_name,
                text: data.as_ref().and_then(semantic_text),
                data,
                truncated: false,
            })
        }
        "Stop" | "StopFailure" => input
            .get("last_assistant_message")
            .and_then(Value::as_str)
            .map(|message| AgentTranscriptInput {
                kind: AgentTranscriptKind::Message,
                source_id: source("message"),
                timestamp,
                role: Some("assistant".to_owned()),
                name: None,
                text: Some(message.to_owned()),
                data: None,
                truncated: false,
            }),
        _ => None,
    };
    record.into_iter().collect()
}

fn semantic_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        _ => serde_json::to_string_pretty(value).ok(),
    }
}

fn agent_event_status(kind: AgentEventKind) -> &'static str {
    kind.activity_label().unwrap_or(match kind {
        AgentEventKind::Completed => "completed",
        AgentEventKind::Closed => "closed",
        _ => "idle",
    })
}

fn is_false(value: &bool) -> bool {
    !*value
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
        "bash" | "exec_command" | "write_stdin" | "shell" | "terminal"
    ) {
        AgentEventKind::RunningCommand
    } else if matches!(
        normalized.as_str(),
        "apply_patch" | "edit" | "write" | "write_file" | "patch" | "multiedit" | "notebookedit"
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
    fn retains_semantic_hook_details_for_supervisor_history() {
        let event = AgentEvent::from_hook_input(
            "codex",
            &serde_json::json!({
                "hook_event_name": "PreToolUse",
                "tool_name": "Bash",
                "tool_input": { "command": "secret command" }
            }),
        )
        .unwrap();
        assert_eq!(event.provider, "codex");
        assert_eq!(event.kind, AgentEventKind::RunningCommand);
        assert!(!event.transcript_only);
        assert!(!event.transcript_reset);
        assert_eq!(event.transcript.len(), 2);
        assert_eq!(event.transcript[0].kind, AgentTranscriptKind::ToolStart);
        assert_eq!(event.transcript[0].name.as_deref(), Some("Bash"));
        assert_eq!(
            event.transcript[0].data,
            Some(serde_json::json!({ "command": "secret command" }))
        );
        assert_eq!(event.transcript[1].kind, AgentTranscriptKind::Status);
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
        assert_eq!(activity.sequence, None);
        assert_eq!(activity.title, None);

        let titled = AgentEvent::from_hook_input(
            "OMP",
            &serde_json::json!({
                "hook_event_name": "agent_start",
                "title": "  fix checkout latency  ",
                "sequence": 42
            }),
        )
        .unwrap();
        assert_eq!(titled.kind, AgentEventKind::Thinking);
        assert_eq!(titled.sequence, Some(42));
        assert_eq!(titled.title.as_deref(), Some("fix checkout latency"));
        // The title and sequence are absent from the wire shape when unset.
        let activity_json = serde_json::to_string(&activity).unwrap();
        assert!(!activity_json.contains("title"));
        assert!(!activity_json.contains("sequence"));
        assert!(
            serde_json::to_string(&titled)
                .unwrap()
                .contains("\"sequence\":42")
        );
    }

    #[test]
    fn accepts_bounded_semantic_transcript_snapshots() {
        let event = AgentEvent::from_hook_input(
            "omp",
            &serde_json::json!({
                "hook_event_name": "transcript_snapshot",
                "transcriptReset": true,
                "transcript": [{
                    "kind": "message",
                    "sourceId": "entry-1",
                    "role": "user",
                    "text": "fix delivery"
                }]
            }),
        )
        .unwrap();
        assert!(event.transcript_only);
        assert!(event.transcript_reset);
        assert_eq!(event.transcript.len(), 1);
        assert_eq!(event.transcript[0].source_id.as_deref(), Some("entry-1"));
        assert_eq!(event.transcript[0].text.as_deref(), Some("fix delivery"));
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

    #[test]
    fn maps_hermes_events_to_shared_activity_kinds() {
        // The Hermes plugin forwards its lifecycle hooks using the shared
        // hook_event_name vocabulary, scoped to the "hermes" provider.
        let cases = [
            ("agent_start", AgentEventKind::Thinking),
            ("tool_execution_start", AgentEventKind::UsingTool),
            ("tool_execution_end", AgentEventKind::Thinking),
            ("PermissionRequest", AgentEventKind::WaitingForApproval),
            ("agent_settled", AgentEventKind::Completed),
            ("session_shutdown", AgentEventKind::Closed),
        ];
        for (name, expected) in cases {
            let event = AgentEvent::from_hook_input(
                "hermes",
                &serde_json::json!({ "hook_event_name": name }),
            )
            .expect(name);
            assert_eq!(event.provider, "hermes", "{name}");
            assert_eq!(event.kind, expected, "{name}");
        }

        // Hermes tool names flow through to specific activity kinds.
        let running = AgentEvent::from_hook_input(
            "hermes",
            &serde_json::json!({
                "hook_event_name": "tool_execution_start",
                "tool_name": "terminal",
            }),
        )
        .unwrap();
        assert_eq!(running.kind, AgentEventKind::RunningCommand);

        let editing = AgentEvent::from_hook_input(
            "hermes",
            &serde_json::json!({
                "hook_event_name": "tool_execution_start",
                "tool_name": "write_file",
            }),
        )
        .unwrap();
        assert_eq!(editing.kind, AgentEventKind::EditingFiles);
    }
}
