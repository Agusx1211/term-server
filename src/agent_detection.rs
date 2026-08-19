//! Screen-based agent state detection.
//!
//! Coding agents that do not report their lifecycle through a term-server
//! integration still show what they are doing on screen: a spinner, a prompt
//! box, an approval dialog. This module classifies a terminal snapshot into
//! [`DetectedState`] by evaluating declarative rules from a per-agent manifest.
//!
//! The manifest format, the structural screen regions, and the deliberate
//! bias toward `idle` when nothing matches come from herdr
//! (<https://github.com/herdrdev/herdr>); the bundled manifests are ported from
//! that project under the Apache License 2.0. See `NOTICE`. The engine below is
//! an independent implementation.
//!
//! Detection is advisory. It never sends input to a terminal, and a rule that
//! recognizes a transient overlay (a transcript viewer, a model picker) sets
//! [`Detection::skip_state_update`] so the caller keeps the last known state
//! instead of guessing from a screen that is not showing the agent.

use std::{
    collections::HashMap,
    env,
    path::{Path, PathBuf},
    sync::{OnceLock, RwLock},
};

use regex::Regex;
use serde::{Deserialize, Serialize};

/// Highest `min_engine_version` this implementation can evaluate. Bump when a
/// new region or matcher is added, so manifests can require it.
const ENGINE_VERSION: u32 = 3;

/// Reason recorded when a known agent matched no rule at all.
pub const DEFAULT_KNOWN_AGENT_IDLE_FALLBACK: &str = "default_known_agent_idle_fallback";

/// Guard rails for untrusted local overrides. A manifest that exceeds any of
/// these is rejected rather than truncated, so a broken override cannot quietly
/// degrade detection.
const MAX_RULES_PER_MANIFEST: usize = 128;
const MAX_GATE_DEPTH: usize = 8;
const MAX_TOTAL_GATES: usize = 512;
const MAX_MATCHERS_PER_GATE: usize = 32;
const MAX_TOTAL_MATCHERS: usize = 1024;
const MAX_MATCHER_CHARS: usize = 512;
const MAX_OVERRIDE_BYTES: u64 = 256 * 1024;

const BUNDLED_MANIFESTS: &[(&str, &str)] = &[
    (
        "claude",
        include_str!("agent_detection/manifests/claude.toml"),
    ),
    (
        "codex",
        include_str!("agent_detection/manifests/codex.toml"),
    ),
    ("pi", include_str!("agent_detection/manifests/pi.toml")),
    (
        "hermes",
        include_str!("agent_detection/manifests/hermes.toml"),
    ),
];

/// The terminal snapshot a manifest is evaluated against.
///
/// `screen` is the rendered live screen, rows joined by `\n`. `osc_title` and
/// `osc_progress` carry the most recent OSC 0/2 title and OSC 9;4 progress
/// payloads; pass empty strings when they are unavailable, which simply makes
/// rules targeting those regions fail to match.
#[derive(Debug, Clone, Copy, Default)]
pub struct DetectionInput<'a> {
    pub screen: &'a str,
    pub osc_title: &'a str,
    pub osc_progress: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DetectedState {
    Idle,
    Working,
    Blocked,
    Unknown,
}

/// The outcome of evaluating one snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Detection {
    pub state: DetectedState,
    /// The matched rule recognized an overlay that hides the agent's real
    /// state. Keep the previous status instead of applying `state`.
    pub skip_state_update: bool,
    /// The match is strong, on-screen evidence rather than a weak heuristic.
    /// Only ever set for the state the rule actually declared.
    pub visible_idle: bool,
    pub visible_blocker: bool,
    pub visible_working: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matched_rule: Option<MatchedRule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchedRule {
    pub id: String,
    pub priority: i32,
    pub region: String,
    pub state: DetectedState,
}

/// Everything [`Detection`] carries plus per-rule evaluation evidence, for
/// debugging a terminal that shows the wrong state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectionExplain {
    pub agent: String,
    #[serde(flatten)]
    pub detection: Detection,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manifest_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manifest_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    pub evaluated_rules: Vec<EvaluatedRule>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluatedRule {
    pub id: String,
    pub priority: i32,
    pub region: String,
    pub state: DetectedState,
    pub matched: bool,
    pub region_bytes: usize,
    pub region_preview: String,
}

/// Where the active manifest for an agent came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManifestSource {
    Bundled,
    Override(PathBuf),
}

impl ManifestSource {
    pub fn label(&self) -> String {
        match self {
            Self::Bundled => "bundled".to_owned(),
            Self::Override(path) => format!("override:{}", path.display()),
        }
    }
}

/// Classify a snapshot for `agent_kind`.
///
/// Returns `None` when no manifest is available for that agent, which leaves
/// the caller on whatever fallback it already had.
pub fn detect(agent_kind: &str, input: DetectionInput<'_>) -> Option<Detection> {
    let cache = manifest_cache().read().ok()?;
    let loaded = cache.get(agent_kind)?;
    Some(evaluate(loaded, input, false).0)
}

/// Classify a snapshot and report how every rule was evaluated.
pub fn explain(agent_kind: &str, input: DetectionInput<'_>) -> Option<DetectionExplain> {
    let cache = manifest_cache().read().ok()?;
    let loaded = cache.get(agent_kind)?;
    let (detection, evaluated_rules) = evaluate(loaded, input, true);
    Some(DetectionExplain {
        agent: agent_kind.to_owned(),
        detection,
        manifest_source: Some(loaded.source.label()),
        manifest_version: loaded.manifest.version.clone(),
        warning: loaded.warning.clone(),
        evaluated_rules,
    })
}

/// Agent kinds that currently have a manifest, bundled or overridden.
pub fn supported_agents() -> Vec<String> {
    let Ok(cache) = manifest_cache().read() else {
        return Vec::new();
    };
    let mut agents: Vec<String> = cache.keys().cloned().collect();
    agents.sort();
    agents
}

/// Rebuild the manifest cache, picking up edited local overrides.
pub fn reload() {
    let cache = build_cache(override_directory().as_deref());
    let lock = manifest_cache();
    match lock.write() {
        Ok(mut guard) => *guard = cache,
        Err(poisoned) => *poisoned.into_inner() = cache,
    }
}

// ---------------------------------------------------------------------------
// Manifest schema
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct AgentManifest {
    #[allow(dead_code)]
    id: String,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    min_engine_version: Option<u32>,
    #[serde(default, rename = "updated_at")]
    _updated_at: Option<String>,
    #[serde(default, rename = "aliases")]
    _aliases: Vec<String>,
    #[serde(default)]
    rules: Vec<ManifestRule>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestRule {
    id: String,
    #[serde(default)]
    state: Option<ManifestState>,
    #[serde(default)]
    priority: i32,
    #[serde(default = "default_region")]
    region: String,
    #[serde(default)]
    visible_idle: bool,
    #[serde(default)]
    visible_blocker: bool,
    #[serde(default)]
    visible_working: bool,
    #[serde(default)]
    skip_state_update: bool,
    // The matcher fields are repeated here rather than flattened, because
    // serde cannot combine `flatten` with `deny_unknown_fields`.
    #[serde(default)]
    all: Vec<ManifestGate>,
    #[serde(default)]
    any: Vec<ManifestGate>,
    #[serde(default, rename = "not")]
    not_gate: Vec<ManifestGate>,
    #[serde(default)]
    contains: Vec<String>,
    #[serde(default)]
    regex: Vec<String>,
    #[serde(default)]
    line_regex: Vec<String>,
}

impl ManifestRule {
    fn gate(&self) -> ManifestGate {
        ManifestGate {
            all: self.all.clone(),
            any: self.any.clone(),
            not_gate: self.not_gate.clone(),
            contains: self.contains.clone(),
            regex: self.regex.clone(),
            line_regex: self.line_regex.clone(),
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestGate {
    #[serde(default)]
    all: Vec<ManifestGate>,
    #[serde(default)]
    any: Vec<ManifestGate>,
    #[serde(default, rename = "not")]
    not_gate: Vec<ManifestGate>,
    #[serde(default)]
    contains: Vec<String>,
    #[serde(default)]
    regex: Vec<String>,
    #[serde(default)]
    line_regex: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ManifestState {
    Idle,
    Working,
    Blocked,
    Unknown,
}

impl From<ManifestState> for DetectedState {
    fn from(value: ManifestState) -> Self {
        match value {
            ManifestState::Idle => Self::Idle,
            ManifestState::Working => Self::Working,
            ManifestState::Blocked => Self::Blocked,
            ManifestState::Unknown => Self::Unknown,
        }
    }
}

fn default_region() -> String {
    "whole_recent".to_owned()
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct CompiledGate {
    all: Vec<CompiledGate>,
    any: Vec<CompiledGate>,
    not_gate: Vec<CompiledGate>,
    /// Lowercased at compile time; matched against a lowercased region.
    contains: Vec<String>,
    regex: Vec<Regex>,
    line_regex: Vec<Regex>,
}

#[derive(Debug, Clone)]
struct LoadedManifest {
    manifest: AgentManifest,
    compiled: Vec<CompiledGate>,
    source: ManifestSource,
    warning: Option<String>,
}

struct CompileBudget {
    gates: usize,
    matchers: usize,
}

fn compile_manifest(manifest: &AgentManifest) -> Result<Vec<CompiledGate>, String> {
    if let Some(required) = manifest.min_engine_version
        && required > ENGINE_VERSION
    {
        return Err(format!(
            "manifest requires engine version {required}, this build supports {ENGINE_VERSION}"
        ));
    }
    if manifest.rules.len() > MAX_RULES_PER_MANIFEST {
        return Err(format!(
            "manifest declares {} rules, the limit is {MAX_RULES_PER_MANIFEST}",
            manifest.rules.len()
        ));
    }

    let mut budget = CompileBudget {
        gates: 0,
        matchers: 0,
    };
    let mut compiled = Vec::with_capacity(manifest.rules.len());
    for rule in &manifest.rules {
        validate_region(&rule.region).map_err(|error| format!("rule '{}': {error}", rule.id))?;
        let gate = compile_gate(&rule.gate(), 0, &mut budget)
            .map_err(|error| format!("rule '{}': {error}", rule.id))?;
        compiled.push(gate);
    }
    Ok(compiled)
}

fn compile_gate(
    gate: &ManifestGate,
    depth: usize,
    budget: &mut CompileBudget,
) -> Result<CompiledGate, String> {
    if depth > MAX_GATE_DEPTH {
        return Err(format!("gates nested deeper than {MAX_GATE_DEPTH}"));
    }
    budget.gates += 1;
    if budget.gates > MAX_TOTAL_GATES {
        return Err(format!(
            "manifest declares more than {MAX_TOTAL_GATES} gates"
        ));
    }

    let matchers = gate.contains.len() + gate.regex.len() + gate.line_regex.len();
    if matchers > MAX_MATCHERS_PER_GATE {
        return Err(format!(
            "a gate declares {matchers} matchers, the limit is {MAX_MATCHERS_PER_GATE}"
        ));
    }
    budget.matchers += matchers;
    if budget.matchers > MAX_TOTAL_MATCHERS {
        return Err(format!(
            "manifest declares more than {MAX_TOTAL_MATCHERS} matchers"
        ));
    }
    for matcher in gate
        .contains
        .iter()
        .chain(&gate.regex)
        .chain(&gate.line_regex)
    {
        if matcher.chars().count() > MAX_MATCHER_CHARS {
            return Err(format!("a matcher exceeds {MAX_MATCHER_CHARS} characters"));
        }
    }

    Ok(CompiledGate {
        all: compile_gates(&gate.all, depth + 1, budget)?,
        any: compile_gates(&gate.any, depth + 1, budget)?,
        not_gate: compile_gates(&gate.not_gate, depth + 1, budget)?,
        contains: gate
            .contains
            .iter()
            .map(|needle| needle.to_lowercase())
            .collect(),
        regex: compile_patterns(&gate.regex)?,
        line_regex: compile_patterns(&gate.line_regex)?,
    })
}

fn compile_gates(
    gates: &[ManifestGate],
    depth: usize,
    budget: &mut CompileBudget,
) -> Result<Vec<CompiledGate>, String> {
    gates
        .iter()
        .map(|gate| compile_gate(gate, depth, budget))
        .collect()
}

fn compile_patterns(patterns: &[String]) -> Result<Vec<Regex>, String> {
    patterns
        .iter()
        .map(|pattern| {
            Regex::new(pattern).map_err(|error| format!("invalid regex '{pattern}': {error}"))
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/// Evaluate every rule, then apply the highest-priority match. Ties keep the
/// earlier rule, so manifest order is the documented tiebreak.
fn evaluate(
    loaded: &LoadedManifest,
    input: DetectionInput<'_>,
    collect_evidence: bool,
) -> (Detection, Vec<EvaluatedRule>) {
    let mut matched: Option<(&ManifestRule, usize)> = None;
    let mut evaluated = Vec::new();

    for (index, (rule, gate)) in loaded
        .manifest
        .rules
        .iter()
        .zip(&loaded.compiled)
        .enumerate()
    {
        let region_text = region(input, &rule.region);
        let is_match = gate_matches_text(gate, region_text);

        if collect_evidence {
            evaluated.push(EvaluatedRule {
                id: rule.id.clone(),
                priority: rule.priority,
                region: rule.region.clone(),
                state: rule_state(rule),
                matched: is_match,
                region_bytes: region_text.len(),
                region_preview: bounded_preview(region_text),
            });
        }

        if !is_match {
            continue;
        }
        match matched {
            Some((previous, _)) if previous.priority >= rule.priority => {}
            _ => matched = Some((rule, index)),
        }
    }

    let Some((rule, _)) = matched else {
        return (
            Detection {
                state: DetectedState::Idle,
                skip_state_update: false,
                visible_idle: false,
                visible_blocker: false,
                visible_working: false,
                matched_rule: None,
                fallback_reason: Some(DEFAULT_KNOWN_AGENT_IDLE_FALLBACK.to_owned()),
            },
            evaluated,
        );
    };

    let state = rule_state(rule);
    (
        Detection {
            state,
            skip_state_update: rule.skip_state_update,
            visible_idle: rule.visible_idle && state == DetectedState::Idle,
            visible_blocker: rule.visible_blocker && state == DetectedState::Blocked,
            visible_working: rule.visible_working && state == DetectedState::Working,
            matched_rule: Some(MatchedRule {
                id: rule.id.clone(),
                priority: rule.priority,
                region: rule.region.clone(),
                state,
            }),
            fallback_reason: None,
        },
        evaluated,
    )
}

fn rule_state(rule: &ManifestRule) -> DetectedState {
    rule.state
        .map_or(DetectedState::Unknown, DetectedState::from)
}

fn gate_matches_text(gate: &CompiledGate, text: &str) -> bool {
    let lowered = text.to_lowercase();
    gate_matches(gate, text, &lowered)
}

/// `contains`, `regex`, `line_regex` and `all` are conjunctions; `any` is a
/// disjunction that is skipped when empty; `not` rejects on any match. An
/// entirely empty gate matches, which is how metadata-only rules behave.
fn gate_matches(gate: &CompiledGate, text: &str, lowered: &str) -> bool {
    if !gate.contains.iter().all(|needle| lowered.contains(needle)) {
        return false;
    }
    if !gate.regex.iter().all(|regex| regex.is_match(text)) {
        return false;
    }
    if !gate
        .line_regex
        .iter()
        .all(|regex| text.lines().any(|line| regex.is_match(line)))
    {
        return false;
    }
    if !gate
        .all
        .iter()
        .all(|nested| gate_matches(nested, text, lowered))
    {
        return false;
    }
    if !gate.any.is_empty()
        && !gate
            .any
            .iter()
            .any(|nested| gate_matches(nested, text, lowered))
    {
        return false;
    }
    if gate
        .not_gate
        .iter()
        .any(|nested| gate_matches(nested, text, lowered))
    {
        return false;
    }
    true
}

fn bounded_preview(text: &str) -> String {
    const MAX_CHARS: usize = 240;
    let mut preview: String = text.chars().take(MAX_CHARS).collect();
    if text.chars().count() > MAX_CHARS {
        preview.push_str("...");
    }
    preview
}

// ---------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------

fn validate_region(spec: &str) -> Result<(), String> {
    let trimmed = spec.trim();
    let known = matches!(
        trimmed,
        "osc_title"
            | "osc_progress"
            | "whole_recent"
            | "after_last_prompt_marker"
            | "after_last_horizontal_rule"
            | "prompt_box_body"
            | "above_prompt_box"
            | "last_non_empty_above_prompt_box"
    ) || region_count(trimmed, "bottom_lines").is_some()
        || region_count(trimmed, "bottom_non_empty_lines").is_some()
        || region_count(trimmed, "top_non_empty_lines").is_some();
    if known {
        Ok(())
    } else {
        Err(format!("unknown region '{spec}'"))
    }
}

fn region<'a>(input: DetectionInput<'a>, spec: &str) -> &'a str {
    let trimmed = spec.trim();
    // OSC regions read their dedicated inputs, not the screen.
    match trimmed {
        "osc_title" => return input.osc_title,
        "osc_progress" => return input.osc_progress,
        _ => {}
    }

    let content = input.screen;
    match trimmed {
        "whole_recent" => content,
        "after_last_prompt_marker" => after_last_prompt_marker(content),
        "after_last_horizontal_rule" => after_last_horizontal_rule(content),
        "prompt_box_body" => prompt_box_body(content).unwrap_or(""),
        "above_prompt_box" => above_prompt_box(content),
        "last_non_empty_above_prompt_box" => last_non_empty_line(above_prompt_box(content)),
        _ => {
            if let Some(count) = region_count(trimmed, "bottom_lines") {
                return bottom_lines(content, count);
            }
            if let Some(count) = region_count(trimmed, "bottom_non_empty_lines") {
                return bottom_non_empty_lines(content, count);
            }
            if let Some(count) = region_count(trimmed, "top_non_empty_lines") {
                return top_non_empty_lines(content, count);
            }
            ""
        }
    }
}

fn region_count(spec: &str, name: &str) -> Option<usize> {
    let count = spec
        .strip_prefix(name)?
        .strip_prefix('(')?
        .strip_suffix(')')?;
    if count.is_empty()
        || count.starts_with('0')
        || !count.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    count
        .parse::<usize>()
        .ok()
        .filter(|count| *count <= usize::from(u16::MAX))
}

/// Byte offsets of each line's start, so region slicing stays correct for
/// `\r\n` input and for content without a trailing newline.
fn line_starts(content: &str) -> Vec<usize> {
    if content.is_empty() {
        return Vec::new();
    }
    let mut starts = vec![0usize];
    for (index, byte) in content.bytes().enumerate() {
        if byte == b'\n' {
            starts.push(index + 1);
        }
    }
    // A trailing newline does not open a further line.
    if starts.last().copied() == Some(content.len()) {
        starts.pop();
    }
    starts
}

fn slice_from_line<'a>(content: &'a str, starts: &[usize], index: usize) -> &'a str {
    let offset = starts.get(index).copied().unwrap_or(content.len());
    &content[offset.min(content.len())..]
}

fn slice_to_line<'a>(content: &'a str, starts: &[usize], index: usize) -> &'a str {
    let offset = starts.get(index).copied().unwrap_or(content.len());
    &content[..offset.min(content.len())]
}

fn bottom_lines(content: &str, count: usize) -> &str {
    let starts = line_starts(content);
    let start = starts.len().saturating_sub(count);
    slice_from_line(content, &starts, start)
}

fn bottom_non_empty_lines(content: &str, count: usize) -> &str {
    let starts = line_starts(content);
    let lines: Vec<&str> = content.lines().collect();
    let Some(start_index) = lines
        .iter()
        .enumerate()
        .rev()
        .filter(|(_, line)| !line.trim().is_empty())
        .take(count)
        .last()
        .map(|(index, _)| index)
    else {
        return "";
    };
    slice_from_line(content, &starts, start_index)
}

fn top_non_empty_lines(content: &str, count: usize) -> &str {
    let starts = line_starts(content);
    let lines: Vec<&str> = content.lines().collect();
    let Some(end_index) = lines
        .iter()
        .enumerate()
        .filter(|(_, line)| !line.trim().is_empty())
        .take(count)
        .last()
        .map(|(index, _)| index)
    else {
        return "";
    };
    slice_to_line(content, &starts, end_index + 1)
}

/// Everything after the last Codex prompt marker line (`›`). Keeps a rule from
/// matching the transcript above the live prompt.
fn after_last_prompt_marker(content: &str) -> &str {
    let starts = line_starts(content);
    let lines: Vec<&str> = content.lines().collect();
    let Some(index) = lines.iter().rposition(|line| codex_prompt_line(line)) else {
        return content;
    };
    slice_from_line(content, &starts, index + 1)
}

fn codex_prompt_line(line: &str) -> bool {
    let trimmed = line.trim_end();
    trimmed == "›" || trimmed.starts_with("› ")
}

/// Everything after the last box-drawing horizontal rule. This is what keeps
/// Claude Code's approval rules off stale transcript text.
fn after_last_horizontal_rule(content: &str) -> &str {
    let starts = line_starts(content);
    let lines: Vec<&str> = content.lines().collect();
    let Some(index) = lines.iter().rposition(|line| is_horizontal_rule(line)) else {
        return content;
    };
    slice_from_line(content, &starts, index + 1)
}

/// The body of the prompt box: the lines between the last two horizontal
/// rules, which for a bordered input box are its top and bottom borders.
fn prompt_box_body(content: &str) -> Option<&str> {
    let starts = line_starts(content);
    let lines: Vec<&str> = content.lines().collect();
    let top = prompt_box_top_border_index(&lines)?;
    let end_index = lines[top + 1..]
        .iter()
        .position(|line| is_horizontal_rule(line))
        .map(|relative| top + 1 + relative)
        .unwrap_or(lines.len());
    let start = starts.get(top + 1).copied().unwrap_or(content.len());
    let end = starts.get(end_index).copied().unwrap_or(content.len());
    Some(&content[start.min(content.len())..end.min(content.len())])
}

fn above_prompt_box(content: &str) -> &str {
    let starts = line_starts(content);
    let lines: Vec<&str> = content.lines().collect();
    let Some(top) = prompt_box_top_border_index(&lines) else {
        return content;
    };
    slice_to_line(content, &starts, top)
}

fn last_non_empty_line(content: &str) -> &str {
    content
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("")
}

fn prompt_box_top_border_index(lines: &[&str]) -> Option<usize> {
    let mut borders = 0;
    for index in (0..lines.len()).rev() {
        if is_horizontal_rule(lines[index]) {
            borders += 1;
            if borders == 2 {
                return Some(index);
            }
        }
    }
    None
}

/// A run of `─` that is either the whole line or at least three characters
/// long, so a box border counts but a stray glyph inside prose does not.
fn is_horizontal_rule(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return false;
    }
    let rule_chars = trimmed
        .chars()
        .take_while(|character| *character == '─')
        .count();
    if rule_chars == 0 {
        return false;
    }
    let rule_bytes = trimmed
        .char_indices()
        .nth(rule_chars)
        .map_or(trimmed.len(), |(index, _)| index);
    let suffix = trimmed[rule_bytes..].trim_start();
    suffix.is_empty() || rule_chars >= 3
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

static MANIFEST_CACHE: OnceLock<RwLock<HashMap<String, LoadedManifest>>> = OnceLock::new();

fn manifest_cache() -> &'static RwLock<HashMap<String, LoadedManifest>> {
    MANIFEST_CACHE.get_or_init(|| RwLock::new(build_cache(override_directory().as_deref())))
}

/// `$XDG_CONFIG_HOME/term-server/agent-detection`, else
/// `~/.config/term-server/agent-detection`.
fn override_directory() -> Option<PathBuf> {
    let base = env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))?;
    Some(base.join("term-server/agent-detection"))
}

fn build_cache(override_directory: Option<&Path>) -> HashMap<String, LoadedManifest> {
    let mut cache = HashMap::new();
    for (agent, bundled) in BUNDLED_MANIFESTS {
        if let Some(loaded) = load_agent(agent, bundled, override_directory) {
            cache.insert((*agent).to_owned(), loaded);
        }
    }
    cache
}

/// A local override replaces the bundled manifest entirely. An unreadable or
/// invalid override is ignored, with the reason recorded on the bundled
/// manifest so `explain` can surface it.
fn load_agent(
    agent: &str,
    bundled: &str,
    override_directory: Option<&Path>,
) -> Option<LoadedManifest> {
    let mut warning = None;

    if let Some(directory) = override_directory {
        let path = directory.join(format!("{agent}.toml"));
        match read_override(&path) {
            Ok(Some(text)) => match parse_manifest(&text) {
                Ok(loaded) => {
                    return Some(LoadedManifest {
                        manifest: loaded.0,
                        compiled: loaded.1,
                        source: ManifestSource::Override(path),
                        warning: None,
                    });
                }
                Err(error) => {
                    tracing::warn!(
                        agent,
                        path = %path.display(),
                        %error,
                        "ignoring invalid agent detection override"
                    );
                    warning = Some(format!("ignored override {}: {error}", path.display()));
                }
            },
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(
                    agent,
                    path = %path.display(),
                    %error,
                    "could not read agent detection override"
                );
                warning = Some(format!(
                    "could not read override {}: {error}",
                    path.display()
                ));
            }
        }
    }

    match parse_manifest(bundled) {
        Ok((manifest, compiled)) => Some(LoadedManifest {
            manifest,
            compiled,
            source: ManifestSource::Bundled,
            warning,
        }),
        Err(error) => {
            // A bundled manifest that does not compile is a build-time bug.
            debug_assert!(false, "bundled manifest for {agent} is invalid: {error}");
            tracing::error!(agent, %error, "bundled agent detection manifest is invalid");
            None
        }
    }
}

fn read_override(path: &Path) -> std::io::Result<Option<String>> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if !metadata.is_file() {
        return Ok(None);
    }
    if metadata.len() > MAX_OVERRIDE_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("override is larger than {MAX_OVERRIDE_BYTES} bytes"),
        ));
    }
    std::fs::read_to_string(path).map(Some)
}

fn parse_manifest(text: &str) -> Result<(AgentManifest, Vec<CompiledGate>), String> {
    let manifest: AgentManifest = toml::from_str(text).map_err(|error| error.to_string())?;
    let compiled = compile_manifest(&manifest)?;
    Ok((manifest, compiled))
}

#[cfg(test)]
mod tests;
