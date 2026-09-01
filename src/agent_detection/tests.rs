use super::*;

fn screen(input: &str) -> DetectionInput<'_> {
    DetectionInput {
        screen: input,
        osc_title: "",
        osc_progress: "",
    }
}

fn bundled(agent: &str) -> LoadedManifest {
    let source = BUNDLED_MANIFESTS
        .iter()
        .find(|(name, _)| *name == agent)
        .map(|(_, text)| *text)
        .expect("bundled manifest");
    let (manifest, compiled) = parse_manifest(source).expect("manifest compiles");
    LoadedManifest {
        manifest,
        compiled,
        source: ManifestSource::Bundled,
        warning: None,
    }
}

fn classify(agent: &str, input: DetectionInput<'_>) -> Detection {
    evaluate(&bundled(agent), input, false).0
}

fn matched_rule_id(detection: &Detection) -> Option<&str> {
    detection.matched_rule.as_ref().map(|rule| rule.id.as_str())
}

// ---------------------------------------------------------------------------
// Manifest integrity
// ---------------------------------------------------------------------------

#[test]
fn every_bundled_manifest_compiles() {
    for (agent, source) in BUNDLED_MANIFESTS {
        let (manifest, compiled) =
            parse_manifest(source).unwrap_or_else(|error| panic!("{agent}: {error}"));
        assert_eq!(manifest.rules.len(), compiled.len(), "{agent}");
        assert!(!manifest.rules.is_empty(), "{agent} declares no rules");
        assert!(
            manifest.min_engine_version.unwrap_or(1) <= ENGINE_VERSION,
            "{agent} requires a newer engine"
        );
    }
}

#[test]
fn rejects_a_manifest_that_needs_a_newer_engine() {
    let error = parse_manifest(&format!(
        "id = \"future\"\nmin_engine_version = {}\n",
        ENGINE_VERSION + 1
    ))
    .expect_err("should reject");
    assert!(error.contains("engine version"), "{error}");
}

#[test]
fn rejects_unknown_regions_and_invalid_regexes() {
    let unknown = parse_manifest(
        r#"
id = "x"
[[rules]]
id = "r"
state = "idle"
region = "somewhere_else"
"#,
    )
    .expect_err("should reject");
    assert!(unknown.contains("unknown region"), "{unknown}");

    let invalid = parse_manifest(
        r#"
id = "x"
[[rules]]
id = "r"
state = "idle"
regex = ["("]
"#,
    )
    .expect_err("should reject");
    assert!(invalid.contains("invalid regex"), "{invalid}");
}

#[test]
fn rejects_manifests_that_exceed_the_compile_budget() {
    let mut source = String::from("id = \"x\"\n");
    for index in 0..(MAX_RULES_PER_MANIFEST + 1) {
        source.push_str(&format!("[[rules]]\nid = \"r{index}\"\nstate = \"idle\"\n"));
    }
    let error = parse_manifest(&source).expect_err("should reject");
    assert!(error.contains("rules"), "{error}");

    let mut nested = String::from("{ contains = [\"x\"] }");
    for _ in 0..(MAX_GATE_DEPTH + 2) {
        nested = format!("{{ any = [{nested}] }}");
    }
    let deep = format!("id = \"x\"\n[[rules]]\nid = \"r\"\nstate = \"idle\"\nany = [{nested}]\n");
    let error = parse_manifest(&deep).expect_err("deep nesting should reject");
    assert!(error.contains("nested deeper"), "{error}");
}

// ---------------------------------------------------------------------------
// Gate semantics
// ---------------------------------------------------------------------------

fn gate_from(toml_source: &str) -> CompiledGate {
    let manifest = format!("id = \"x\"\n[[rules]]\nid = \"r\"\nstate = \"idle\"\n{toml_source}");
    let (_, compiled) = parse_manifest(&manifest).expect("compiles");
    compiled.into_iter().next().expect("one rule")
}

#[test]
fn contains_is_case_insensitive_and_conjunctive() {
    let gate = gate_from("contains = [\"Action Required\", \"codex\"]\n");
    assert!(gate_matches_text(&gate, "codex — ACTION REQUIRED"));
    assert!(!gate_matches_text(&gate, "action required"));
}

#[test]
fn regex_is_case_sensitive_against_the_original_text() {
    let gate = gate_from("regex = ['^\\u2733 ']\n");
    assert!(gate_matches_text(&gate, "\u{2733} Claude"));
    assert!(!gate_matches_text(&gate, "x \u{2733} Claude"));
}

#[test]
fn line_regex_matches_any_single_line() {
    let gate = gate_from("line_regex = ['(?i)^\\s*2\\.\\s*no\\b']\n");
    assert!(gate_matches_text(
        &gate,
        "Do you want to proceed?\n  1. Yes\n  2. No, and tell Claude why"
    ));
    // The pattern must match within one line, not across the joined text.
    let split = gate_from("line_regex = ['yes.*no']\n");
    assert!(!gate_matches_text(&split, "yes\nno"));
}

#[test]
fn any_is_a_disjunction_and_not_rejects() {
    let gate = gate_from(
        r#"
contains = ["proceed"]
any = [
  { contains = ["bash"] },
  { contains = ["edit"] },
]
not = [{ contains = ["cancelled"] }]
"#,
    );
    assert!(gate_matches_text(&gate, "proceed with bash"));
    assert!(gate_matches_text(&gate, "proceed with edit"));
    assert!(!gate_matches_text(&gate, "proceed with search"));
    assert!(!gate_matches_text(&gate, "proceed with bash — cancelled"));
}

#[test]
fn an_empty_gate_matches_anything() {
    let gate = gate_from("");
    assert!(gate_matches_text(&gate, ""));
    assert!(gate_matches_text(&gate, "anything at all"));
}

// ---------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------

// Screen fixtures are written as literal multi-line strings: a `\`-continued
// literal would strip the leading indentation that the regions depend on.
const BOXED: &str = "transcript line
────────────────
  ❯ type here
────────────────
  ? for shortcuts";

#[test]
fn bottom_non_empty_lines_skips_trailing_blanks() {
    let content = "one\ntwo\nthree\n\n   \n";
    assert_eq!(bottom_non_empty_lines(content, 2), "two\nthree\n\n   \n");
    assert_eq!(bottom_non_empty_lines("", 3), "");
    assert_eq!(bottom_non_empty_lines("\n  \n", 3), "");
}

#[test]
fn bottom_lines_counts_from_the_end() {
    assert_eq!(bottom_lines("a\nb\nc", 2), "b\nc");
    assert_eq!(bottom_lines("a\nb\nc", 9), "a\nb\nc");
}

#[test]
fn top_non_empty_lines_counts_from_the_start() {
    assert_eq!(top_non_empty_lines("\na\nb\nc", 2), "\na\nb\n");
    assert_eq!(top_non_empty_lines("   \n", 1), "");
}

#[test]
fn after_last_horizontal_rule_isolates_the_live_tail() {
    assert_eq!(
        after_last_horizontal_rule(BOXED),
        "  ? for shortcuts".to_owned()
    );
    // No rule at all means the whole screen stays in scope.
    assert_eq!(after_last_horizontal_rule("plain"), "plain");
}

#[test]
fn horizontal_rules_need_a_full_line_or_three_characters() {
    assert!(is_horizontal_rule("────"));
    assert!(is_horizontal_rule("  ───  "));
    assert!(is_horizontal_rule("─── tail"));
    assert!(!is_horizontal_rule("─ tail"));
    assert!(!is_horizontal_rule("╭──────╮"));
    assert!(!is_horizontal_rule(""));
    assert!(!is_horizontal_rule("   "));
}

#[test]
fn prompt_box_body_reads_between_the_last_two_rules() {
    assert_eq!(prompt_box_body(BOXED), Some("  \u{276f} type here\n"));
    assert_eq!(above_prompt_box(BOXED), "transcript line\n");
    assert_eq!(prompt_box_body("no rules here"), None);
    assert_eq!(above_prompt_box("no rules here"), "no rules here");
}

#[test]
fn after_last_prompt_marker_follows_the_codex_caret() {
    let content = "\u{2022} Ran ls\n\u{203a} \n  allow command?";
    assert_eq!(after_last_prompt_marker(content), "  allow command?");
    assert_eq!(after_last_prompt_marker("no caret"), "no caret");
}

#[test]
fn regions_handle_crlf_and_missing_trailing_newline() {
    let content = "a\r\n────\r\nb";
    assert_eq!(after_last_horizontal_rule(content), "b");
    assert_eq!(bottom_lines(content, 1), "b");
}

// ---------------------------------------------------------------------------
// Priority and fallback
// ---------------------------------------------------------------------------

#[test]
fn the_highest_priority_match_wins_and_ties_keep_the_earlier_rule() {
    let source = r#"
id = "x"
[[rules]]
id = "low"
state = "working"
priority = 10
contains = ["shared"]
[[rules]]
id = "first_tie"
state = "blocked"
priority = 50
contains = ["shared"]
[[rules]]
id = "second_tie"
state = "idle"
priority = 50
contains = ["shared"]
"#;
    let (manifest, compiled) = parse_manifest(source).expect("compiles");
    let loaded = LoadedManifest {
        manifest,
        compiled,
        source: ManifestSource::Bundled,
        warning: None,
    };
    let detection = evaluate(&loaded, screen("shared"), false).0;
    assert_eq!(detection.state, DetectedState::Blocked);
    assert_eq!(matched_rule_id(&detection), Some("first_tie"));
}

#[test]
fn a_known_agent_with_no_match_falls_back_to_idle() {
    let detection = classify("claude", screen("nothing recognizable here"));
    assert_eq!(detection.state, DetectedState::Idle);
    assert_eq!(detection.matched_rule, None);
    assert_eq!(
        detection.fallback_reason.as_deref(),
        Some(DEFAULT_KNOWN_AGENT_IDLE_FALLBACK)
    );
    // The fallback is a guess, never presented as visible evidence.
    assert!(!detection.visible_idle);
}

#[test]
fn visible_flags_only_apply_to_the_state_the_rule_declared() {
    let source = r#"
id = "x"
[[rules]]
id = "mismatched"
state = "idle"
visible_blocker = true
visible_idle = true
contains = ["hello"]
"#;
    let (manifest, compiled) = parse_manifest(source).expect("compiles");
    let loaded = LoadedManifest {
        manifest,
        compiled,
        source: ManifestSource::Bundled,
        warning: None,
    };
    let detection = evaluate(&loaded, screen("hello"), false).0;
    assert!(detection.visible_idle);
    assert!(!detection.visible_blocker);
}

#[test]
fn detect_returns_nothing_for_an_agent_without_a_manifest() {
    assert!(detect("not-an-agent", screen("anything")).is_none());
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

const CLAUDE_APPROVAL: &str = "● I'll clear the build directory.

  Bash command
  rm -rf build

  Do you want to proceed?
  ❯ 1. Yes
    2. No, and tell Claude what to do differently (esc)
";

#[test]
fn claude_permission_prompt_is_blocked() {
    let detection = classify("claude", screen(CLAUDE_APPROVAL));
    assert_eq!(detection.state, DetectedState::Blocked);
    assert_eq!(matched_rule_id(&detection), Some("bash_permission_prompt"));
    assert!(detection.visible_blocker);
    assert!(!detection.skip_state_update);
}

#[test]
fn claude_resolved_approval_above_a_live_prompt_box_is_idle() {
    // The same approval text, now scrolled above the live input box. The
    // higher-priority live prompt rule has to win, or every terminal would
    // stay blocked for the rest of the session.
    let resolved = format!(
        "{CLAUDE_APPROVAL}\n\u{25cf} Removed the build directory.\n\
         ────────────────────────────\n\
           \u{276f} \n\
         ────────────────────────────\n\
           ? for shortcuts"
    );
    let detection = classify("claude", screen(&resolved));
    assert_eq!(detection.state, DetectedState::Idle);
    assert_eq!(matched_rule_id(&detection), Some("live_prompt_box"));
}

#[test]
fn claude_transcript_viewer_freezes_the_last_known_state() {
    let transcript = "  Showing detailed transcript · ctrl+o to toggle\n\
                        \u{2191}\u{2193} scroll\n";
    let detection = classify("claude", screen(transcript));
    assert!(detection.skip_state_update);
    assert_eq!(detection.state, DetectedState::Unknown);
    assert_eq!(matched_rule_id(&detection), Some("transcript_viewer"));
}

#[test]
fn claude_spinner_in_the_window_title_is_working() {
    let detection = classify(
        "claude",
        DetectionInput {
            screen: "",
            // A braille spinner frame, which is what Claude Code writes while
            // it is working.
            osc_title: "\u{2801} Building",
            osc_progress: "",
        },
    );
    assert_eq!(detection.state, DetectedState::Working);
    assert_eq!(matched_rule_id(&detection), Some("osc_title_working"));
    assert!(detection.visible_working);
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

#[test]
fn codex_action_required_title_is_blocked() {
    let detection = classify(
        "codex",
        DetectionInput {
            screen: "some transcript",
            osc_title: "\u{2733} Action Required",
            osc_progress: "",
        },
    );
    assert_eq!(detection.state, DetectedState::Blocked);
    assert_eq!(matched_rule_id(&detection), Some("osc_title_blocked"));
    assert!(detection.visible_blocker);
}

#[test]
fn codex_spinner_title_is_working_and_plain_title_is_idle() {
    let working = classify(
        "codex",
        DetectionInput {
            screen: "",
            osc_title: "\u{2839} codex",
            osc_progress: "",
        },
    );
    assert_eq!(working.state, DetectedState::Working);

    let idle = classify(
        "codex",
        DetectionInput {
            screen: "",
            osc_title: "codex",
            osc_progress: "",
        },
    );
    assert_eq!(idle.state, DetectedState::Idle);
    assert_eq!(matched_rule_id(&idle), Some("osc_title_idle"));
}

#[test]
fn codex_approval_below_the_prompt_marker_is_blocked() {
    let content = "\u{2022} Ran ls\n\u{203a} \n  allow command?\n";
    let detection = classify("codex", screen(content));
    assert_eq!(detection.state, DetectedState::Blocked);
    assert_eq!(matched_rule_id(&detection), Some("live_strong_blocker"));
}

#[test]
fn codex_working_footer_is_working() {
    let content = "\u{2022} Working (12s \u{b7} esc to interrupt)\n";
    let detection = classify("codex", screen(content));
    assert_eq!(detection.state, DetectedState::Working);
    assert_eq!(matched_rule_id(&detection), Some("screen_working_fallback"));
}

// ---------------------------------------------------------------------------
// Pi
// ---------------------------------------------------------------------------

#[test]
fn pi_working_literal_is_working() {
    let detection = classify("pi", screen("Working... (esc to interrupt)"));
    assert_eq!(detection.state, DetectedState::Working);
    assert!(detection.visible_working);
}

// ---------------------------------------------------------------------------
// Hermes
// ---------------------------------------------------------------------------

#[test]
fn hermes_osc_title_markers_map_to_blocked_working_idle() {
    // Hermes sets its OSC title with a leading marker: `⚠` while waiting on an
    // approval/sudo/secret/clarify overlay, `⏳` while a turn is running, and
    // `✓` when idle at the composer. The manifest reads the marker directly.
    let blocked = classify(
        "hermes",
        DetectionInput {
            screen: "",
            osc_title: "\u{26a0} fix-bug \u{b7} model \u{b7} /repo",
            osc_progress: "",
        },
    );
    assert_eq!(blocked.state, DetectedState::Blocked);
    assert_eq!(matched_rule_id(&blocked), Some("osc_title_blocked"));
    assert!(blocked.visible_blocker);

    let working = classify(
        "hermes",
        DetectionInput {
            screen: "",
            osc_title: "\u{23f3} fix-bug \u{b7} model",
            osc_progress: "",
        },
    );
    assert_eq!(working.state, DetectedState::Working);
    assert_eq!(matched_rule_id(&working), Some("osc_title_working"));
    assert!(working.visible_working);

    let idle = classify(
        "hermes",
        DetectionInput {
            screen: "",
            osc_title: "\u{2713} fix-bug \u{b7} model",
            osc_progress: "",
        },
    );
    assert_eq!(idle.state, DetectedState::Idle);
    assert_eq!(matched_rule_id(&idle), Some("osc_title_idle"));
    assert!(idle.visible_idle);
}

#[test]
fn hermes_osc_title_marker_tolerates_a_variation_selector() {
    // The marker may be followed by a Unicode variation selector before the
    // separating space (e.g. ⚠️ U+26A0 U+FE0F), which must not defeat the rule.
    let detection = classify(
        "hermes",
        DetectionInput {
            screen: "",
            osc_title: "\u{26a0}\u{fe0f} fix-bug",
            osc_progress: "",
        },
    );
    assert_eq!(detection.state, DetectedState::Blocked);
    assert_eq!(matched_rule_id(&detection), Some("osc_title_blocked"));
}

#[test]
fn hermes_clarification_overlay_is_blocked_from_the_screen() {
    // Without the window title (a terminal that never saw an OSC title), the
    // clarification prompt still has to register as blocked.
    let detection = classify(
        "hermes",
        screen("\u{2191}\u{2193} to select\n\n  hermes needs your input\n\n  enter to confirm"),
    );
    assert_eq!(detection.state, DetectedState::Blocked);
    assert_eq!(matched_rule_id(&detection), Some("clarification_prompt"));
}

// ---------------------------------------------------------------------------
// Explain
// ---------------------------------------------------------------------------

#[test]
fn explain_reports_every_rule_and_the_winner() {
    let loaded = bundled("codex");
    let (detection, evaluated) = evaluate(
        &loaded,
        DetectionInput {
            screen: "",
            osc_title: "\u{2733} Action Required",
            osc_progress: "",
        },
        true,
    );
    assert_eq!(evaluated.len(), loaded.manifest.rules.len());
    assert_eq!(
        evaluated.iter().filter(|rule| rule.matched).count(),
        1,
        "only the title rule should match an otherwise empty screen"
    );
    let winner = evaluated
        .iter()
        .find(|rule| rule.matched)
        .expect("a matched rule");
    assert_eq!(winner.id, "osc_title_blocked");
    assert_eq!(winner.region, "osc_title");
    assert_eq!(matched_rule_id(&detection), Some("osc_title_blocked"));
}

#[test]
fn explain_previews_are_bounded() {
    let long = "x".repeat(1_000);
    let preview = bounded_preview(&long);
    assert!(preview.ends_with("..."));
    assert_eq!(preview.chars().count(), 243);
}

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

fn write_override(directory: &Path, agent: &str, body: &str) {
    std::fs::create_dir_all(directory).expect("create override directory");
    std::fs::write(directory.join(format!("{agent}.toml")), body).expect("write override");
}

#[test]
fn a_valid_override_replaces_the_bundled_manifest() {
    let temporary = tempfile::tempdir().expect("temp dir");
    write_override(
        temporary.path(),
        "codex",
        r#"
id = "codex"
version = "test"
[[rules]]
id = "everything_is_blocked"
state = "blocked"
priority = 10
contains = ["anything"]
"#,
    );

    let cache = build_cache(Some(temporary.path()));
    let loaded = cache.get("codex").expect("codex manifest");
    assert!(matches!(loaded.source, ManifestSource::Override(_)));
    assert_eq!(loaded.manifest.version.as_deref(), Some("test"));
    assert_eq!(loaded.manifest.rules.len(), 1);

    let detection = evaluate(loaded, screen("anything"), false).0;
    assert_eq!(detection.state, DetectedState::Blocked);

    // Agents without an override keep their bundled manifest.
    let claude = cache.get("claude").expect("claude manifest");
    assert_eq!(claude.source, ManifestSource::Bundled);
}

#[test]
fn an_invalid_override_falls_back_to_the_bundled_manifest_with_a_warning() {
    let temporary = tempfile::tempdir().expect("temp dir");
    write_override(
        temporary.path(),
        "codex",
        "id = \"codex\"\nthis is not toml [[[",
    );

    let cache = build_cache(Some(temporary.path()));
    let loaded = cache.get("codex").expect("codex manifest");
    assert_eq!(loaded.source, ManifestSource::Bundled);
    let warning = loaded.warning.as_deref().expect("a warning");
    assert!(warning.contains("ignored override"), "{warning}");

    // Detection still works off the bundled rules.
    let detection = evaluate(
        loaded,
        DetectionInput {
            screen: "",
            osc_title: "\u{2733} Action Required",
            osc_progress: "",
        },
        false,
    )
    .0;
    assert_eq!(detection.state, DetectedState::Blocked);
}

#[test]
fn an_oversized_override_is_ignored() {
    let temporary = tempfile::tempdir().expect("temp dir");
    let bloat = format!(
        "id = \"codex\"\n# {}\n",
        "x".repeat(MAX_OVERRIDE_BYTES as usize + 1)
    );
    write_override(temporary.path(), "codex", &bloat);

    let cache = build_cache(Some(temporary.path()));
    let loaded = cache.get("codex").expect("codex manifest");
    assert_eq!(loaded.source, ManifestSource::Bundled);
    assert!(
        loaded
            .warning
            .as_deref()
            .is_some_and(|warning| warning.contains("could not read override")),
        "{:?}",
        loaded.warning
    );
}

// ---------------------------------------------------------------------------
// Real captured screens
// ---------------------------------------------------------------------------

/// Screens captured from Claude Code v2.1.220 with `tmux capture-pane -p`,
/// redacted only for account details and paths.
///
/// The tests above are written from the manifests, so they prove the engine
/// agrees with the rules as read. These prove the rules agree with what the
/// agent actually draws, which is the thing that silently breaks when an agent
/// release changes its UI. Recapture with `classify_captured_screen` below.
struct RealScreen {
    description: &'static str,
    agent: &'static str,
    screen: &'static str,
    /// The OSC title captured alongside the screen. Codex's highest-priority
    /// rules read this rather than the screen.
    osc_title: &'static str,
    expected_state: DetectedState,
    expected_rule: &'static str,
}

const CLAUDE_REAL_SCREENS: &[RealScreen] = &[
    RealScreen {
        description: "claude bash permission dialog",
        agent: "claude",
        screen: include_str!("fixtures/claude-bash-permission.txt"),
        osc_title: "",
        expected_state: DetectedState::Blocked,
        expected_rule: "bash_permission_prompt",
    },
    RealScreen {
        description: "claude folder trust dialog",
        agent: "claude",
        screen: include_str!("fixtures/claude-trust-folder.txt"),
        osc_title: "",
        expected_state: DetectedState::Blocked,
        expected_rule: "live_blocked_form",
    },
    RealScreen {
        description: "claude idle prompt box",
        agent: "claude",
        screen: include_str!("fixtures/claude-prompt-box.txt"),
        osc_title: "",
        expected_state: DetectedState::Idle,
        expected_rule: "live_prompt_box",
    },
    RealScreen {
        description: "claude prompt box after an interrupted turn",
        agent: "claude",
        screen: include_str!("fixtures/claude-after-interrupt.txt"),
        osc_title: "",
        expected_state: DetectedState::Idle,
        expected_rule: "live_prompt_box",
    },
    // Derived from the capture above by restoring the streaming spinner line
    // Claude draws in that position while a turn is in flight; everything else
    // is the same v2.1.220 screen, prompt box included.
    RealScreen {
        description: "claude streaming a turn with the prompt box drawn",
        agent: "claude",
        screen: include_str!("fixtures/claude-working.txt"),
        osc_title: "",
        expected_state: DetectedState::Working,
        expected_rule: "screen_working_stream",
    },
    RealScreen {
        description: "codex command approval",
        agent: "codex",
        screen: include_str!("fixtures/codex-command-approval.txt"),
        osc_title: "[ ! ] Action Required | project",
        expected_state: DetectedState::Blocked,
        expected_rule: "osc_title_blocked",
    },
    RealScreen {
        description: "codex idle prompt",
        agent: "codex",
        screen: include_str!("fixtures/codex-prompt-idle.txt"),
        osc_title: "project",
        expected_state: DetectedState::Idle,
        expected_rule: "osc_title_idle",
    },
    RealScreen {
        description: "codex prompt after escaping an approval",
        agent: "codex",
        screen: include_str!("fixtures/codex-after-escape.txt"),
        osc_title: "project",
        expected_state: DetectedState::Idle,
        expected_rule: "osc_title_idle",
    },
];

fn classify_real(capture: &RealScreen) -> Detection {
    classify(
        capture.agent,
        DetectionInput {
            screen: capture.screen,
            osc_title: capture.osc_title,
            osc_progress: "",
        },
    )
}

#[test]
fn classifies_real_agent_screens() {
    for capture in CLAUDE_REAL_SCREENS {
        let detection = classify_real(capture);
        assert_eq!(
            detection.state, capture.expected_state,
            "{}",
            capture.description
        );
        assert_eq!(
            matched_rule_id(&detection),
            Some(capture.expected_rule),
            "{}",
            capture.description
        );
    }
}

#[test]
fn claude_streaming_a_turn_is_working_without_the_window_title() {
    // Claude keeps its input box drawn while it streams, and tmux does not
    // forward the inner OSC title unless `set-titles on`. Without a
    // screen-based working rule, `live_prompt_box` matched mid-turn and the
    // terminal flipped to idle: the task was marked complete, a summary was
    // requested, and the session read as needing attention while the agent was
    // still working.
    let detection = classify(
        "claude",
        screen(include_str!("fixtures/claude-working.txt")),
    );
    assert_eq!(detection.state, DetectedState::Working);
    assert_eq!(matched_rule_id(&detection), Some("screen_working_stream"));
    assert!(
        detection.visible_working,
        "working has to be visible evidence to apply"
    );
    assert_eq!(
        crate::terminal::screen_detection_outcome(Some(&detection)),
        crate::terminal::DetectionOutcome::Status(crate::terminal::AgentStatus::Working),
    );

    // The window title still wins when it is available.
    let titled = classify(
        "claude",
        DetectionInput {
            screen: include_str!("fixtures/claude-working.txt"),
            osc_title: "\u{2800} project",
            osc_progress: "",
        },
    );
    assert_eq!(matched_rule_id(&titled), Some("osc_title_working"));

    // The same screen once the turn ends is idle again, from the screen alone.
    let finished = classify(
        "claude",
        screen(include_str!("fixtures/claude-after-interrupt.txt")),
    );
    assert_eq!(finished.state, DetectedState::Idle);
    assert_eq!(matched_rule_id(&finished), Some("live_prompt_box"));
}

#[test]
fn a_claude_permission_dialog_still_outranks_the_streaming_rule() {
    // The interrupt hint is replaced by the dialog, so a blocked screen must
    // not start reading as working.
    for fixture in [
        include_str!("fixtures/claude-bash-permission.txt"),
        include_str!("fixtures/claude-trust-folder.txt"),
    ] {
        let detection = classify("claude", screen(fixture));
        assert_eq!(detection.state, DetectedState::Blocked);
        assert!(detection.visible_blocker);
    }
}

#[test]
fn codex_approval_is_blocked_from_the_screen_without_the_window_title() {
    // The title is the strongest Codex signal but it is not always available -
    // a terminal that has not seen an OSC title since the agent started has
    // only the screen. The approval still has to register.
    let detection = classify(
        "codex",
        screen(include_str!("fixtures/codex-command-approval.txt")),
    );
    assert_eq!(detection.state, DetectedState::Blocked);
    assert_eq!(matched_rule_id(&detection), Some("live_strong_blocker"));
}

#[test]
fn codex_directory_trust_prompt_is_a_known_detection_gap() {
    // Captured from Codex v0.147.0 at startup: "Do you trust the contents of
    // this directory?" with numbered options. No bundled rule matches it, so
    // the terminal keeps its heuristic state instead of reporting blocked.
    //
    // This characterizes current behaviour rather than endorsing it. If a
    // manifest update starts matching this screen, this test fails and should
    // be promoted into CLAUDE_REAL_SCREENS.
    let detection = classify(
        "codex",
        screen(include_str!("fixtures/codex-trust-directory.txt")),
    );
    assert_eq!(detection.matched_rule, None);
    assert_eq!(
        detection.fallback_reason.as_deref(),
        Some(DEFAULT_KNOWN_AGENT_IDLE_FALLBACK)
    );
    assert_eq!(
        crate::terminal::screen_detection_outcome(Some(&detection)),
        crate::terminal::DetectionOutcome::Undecided,
        "an unmatched screen must not decide anything"
    );
}

#[test]
fn a_resolved_claude_permission_dialog_stops_reading_as_blocked() {
    // The reason detection earns its place next to lifecycle hooks: a hook
    // reports that an approval was requested but not reliably that it was
    // dismissed. Escaping the dialog has to return the terminal to idle on the
    // very next sample, from the screen alone.
    let blocked = classify_real(&CLAUDE_REAL_SCREENS[0]);
    assert_eq!(blocked.state, DetectedState::Blocked);

    let cleared = classify_real(&CLAUDE_REAL_SCREENS[3]);
    assert_eq!(cleared.state, DetectedState::Idle);
    assert!(
        cleared.visible_idle,
        "idle has to be visible evidence to apply"
    );
}

// ---------------------------------------------------------------------------
// Replaying a real session
// ---------------------------------------------------------------------------

/// Classifies a screen captured from a real agent, printing the winning rule
/// and every rule that matched.
///
/// Capture one with `tmux capture-pane -p` while the agent is showing the UI
/// in question, then:
///
/// ```text
/// TERM_SERVER_SCREEN=/tmp/claude-approval.txt TERM_SERVER_AGENT=claude \
///   cargo test --lib classify_captured_screen -- --ignored --nocapture
/// ```
#[test]
#[ignore = "requires a screen capture in TERM_SERVER_SCREEN"]
fn classify_captured_screen() {
    let path =
        std::env::var("TERM_SERVER_SCREEN").expect("set TERM_SERVER_SCREEN to a screen capture");
    let agent_kind = std::env::var("TERM_SERVER_AGENT").expect("set TERM_SERVER_AGENT");
    let screen = std::fs::read_to_string(&path).expect("read screen capture");
    let osc_title = std::env::var("TERM_SERVER_OSC_TITLE").unwrap_or_default();

    let explained = explain(
        &agent_kind,
        DetectionInput {
            screen: &screen,
            osc_title: &osc_title,
            osc_progress: "",
        },
    )
    .unwrap_or_else(|| panic!("no manifest for agent '{agent_kind}'"));

    let outcome = crate::terminal::screen_detection_outcome(Some(&explained.detection));
    println!(
        "\n=== {path} as '{agent_kind}' ({} bytes) ===",
        screen.len()
    );
    println!("engine state : {:?}", explained.detection.state);
    println!("applied      : {outcome:?}");
    println!("winning rule : {:?}", explained.detection.matched_rule);
    println!("fallback     : {:?}", explained.detection.fallback_reason);
    println!("\nrules that matched:");
    for rule in explained.evaluated_rules.iter().filter(|rule| rule.matched) {
        println!(
            "  {:<28} p{:<5} {:<32} -> {:?}",
            rule.id, rule.priority, rule.region, rule.state
        );
    }
    println!("\nrules that did not match:");
    for rule in explained
        .evaluated_rules
        .iter()
        .filter(|rule| !rule.matched)
    {
        println!(
            "  {:<28} p{:<5} {:<32} (region {} bytes)",
            rule.id, rule.priority, rule.region, rule.region_bytes
        );
    }
}

/// Replays a recorded terminal session through the real pipeline and prints
/// what detection concluded.
///
/// The tests above are written from the manifests, so they only prove the
/// engine agrees with itself. This runs captured bytes from an actual session
/// through the same `TerminalOutputState` the server uses, which is the only
/// way to check the rules against the UI an agent really draws.
///
/// ```text
/// TERM_SERVER_CAPTURE=captures/2/session.json TERM_SERVER_AGENT=claude \
///   cargo test --lib replay_capture -- --ignored --nocapture
/// ```
#[test]
#[ignore = "requires a capture file in TERM_SERVER_CAPTURE"]
fn replay_capture_through_detection() {
    use base64::Engine as _;
    use std::collections::BTreeMap;

    let path = std::env::var("TERM_SERVER_CAPTURE")
        .expect("set TERM_SERVER_CAPTURE to a debug recording path");
    let agent_kind = std::env::var("TERM_SERVER_AGENT").unwrap_or_else(|_| "pi".to_owned());
    let raw = std::fs::read_to_string(&path).expect("read capture");
    let capture: serde_json::Value = serde_json::from_str(&raw).expect("parse capture");
    let events = capture["events"].as_array().expect("events array");

    // The capture records the terminal's real size; replaying at some other
    // size rewraps everything and invalidates the region rules.
    let (rows, cols) = events
        .iter()
        .find_map(|event| {
            let message = &event["message"];
            (message["type"].as_str() == Some("size")).then(|| {
                (
                    message["rows"].as_u64().unwrap_or(24) as u16,
                    message["cols"].as_u64().unwrap_or(80) as u16,
                )
            })
        })
        .unwrap_or((24, 80));
    println!("replaying at {rows}x{cols}");

    let mut terminal = crate::terminal_state::TerminalOutputState::new(4 * 1024 * 1024, rows, cols);
    let mut totals: BTreeMap<String, usize> = BTreeMap::new();
    let mut transitions: Vec<(usize, String, Option<String>)> = Vec::new();
    let mut recorded: BTreeMap<String, usize> = BTreeMap::new();
    let mut previous = String::new();
    let mut frames = 0usize;

    for event in events {
        match event["type"].as_str() {
            Some("control") => {
                let message = &event["message"];
                if message["type"].as_str() == Some("size")
                    && let (Some(rows), Some(cols)) =
                        (message["rows"].as_u64(), message["cols"].as_u64())
                {
                    terminal.resize(rows as u16, cols as u16, 0, 0);
                }
                // What the recording's own server concluded, as ground truth.
                if let Some(status) = message["terminal"]["agent"]["status"].as_str() {
                    *recorded.entry(status.to_owned()).or_default() += 1;
                }
                continue;
            }
            Some("output") => {}
            _ => continue,
        }
        let Some(encoded) = event["data"].as_str() else {
            continue;
        };
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(encoded) else {
            continue;
        };
        terminal.publish(bytes::Bytes::from(bytes));
        frames += 1;

        let screen = terminal.detection_text();
        let detection = detect(
            &agent_kind,
            DetectionInput {
                screen: &screen,
                osc_title: "",
                osc_progress: "",
            },
        )
        .unwrap_or_else(|| panic!("no manifest for agent '{agent_kind}'"));

        // Report what the server would actually apply, not the raw engine
        // state: the no-rule-matched idle fallback is deliberately ignored, so
        // printing it would invent transitions that never reach a terminal.
        let outcome = crate::terminal::screen_detection_outcome(Some(&detection));
        let rule = detection.matched_rule.as_ref().map(|rule| rule.id.clone());
        let applied = format!("{outcome:?}");
        *totals.entry(applied.clone()).or_default() += 1;
        let signature = format!("{applied}/{rule:?}");
        if signature != previous {
            transitions.push((frames, applied, rule));
            previous = signature;
        }
    }

    println!("\n=== replayed {frames} output frames as '{agent_kind}' ===");
    println!("applied outcome totals: {totals:?}");
    println!("status recorded by the capturing server: {recorded:?}");
    println!("\ntransitions (frame, applied outcome, matched rule):");
    for (frame, state, rule) in transitions.iter().take(60) {
        println!("  {frame:>6}  {state:<24} {rule:?}");
    }
    if transitions.len() > 60 {
        println!("  ... {} more transitions", transitions.len() - 60);
    }
    println!("\n=== final screen ===");
    for line in terminal.detection_text().lines() {
        println!("|{line}");
    }
    assert!(frames > 0, "capture contained no output frames");
}

#[test]
fn a_missing_override_directory_is_not_an_error() {
    let cache = build_cache(Some(Path::new("/nonexistent/term-server/agent-detection")));
    assert_eq!(cache.len(), BUNDLED_MANIFESTS.len());
    for loaded in cache.values() {
        assert_eq!(loaded.source, ManifestSource::Bundled);
        assert!(loaded.warning.is_none());
    }
}
