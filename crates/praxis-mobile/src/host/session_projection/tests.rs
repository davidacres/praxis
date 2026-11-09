//! Ports of `mobileSessionProjection.test.ts`.

use serde_json::json;

use super::*;
use crate::host::ledger::{InMemoryMobileCommandLedger, MOBILE_REPLAY_LIMIT};
use crate::host::session_record::{MobileSessionEventRecord as Event, MobileTaskDefinition};

fn record() -> MobileSessionRecord {
    MobileSessionRecord {
        issue_key: "SESSION-1".into(),
        session_id: "s1".into(),
        title: Some("Mobile session".into()),
        provider: Some("openai".into()),
        model: Some("gpt-5".into()),
        state: "executing".into(),
        task_definition: MobileTaskDefinition {
            goal: "Help".into(),
        },
        mode: Some("chat".into()),
        started_at: "2026-09-22T09:00:00.000Z".into(),
        events: vec![
            Event::new("2026-09-22T09:00:00.000Z", "user_input_completed", "Hello"),
            Event::new("2026-09-22T09:00:01.000Z", "message", "Earlier answer"),
        ],
        response_text: Some("Streaming now".into()),
        ..MobileSessionRecord::default()
    }
}

fn shape(snapshot: &MobileSessionSnapshot) -> Vec<(String, String, String)> {
    snapshot
        .messages
        .iter()
        .map(|m| (m.role.clone(), m.text.clone(), m.status.clone()))
        .collect()
}

fn roles(snapshot: &MobileSessionSnapshot) -> Vec<(String, String)> {
    snapshot
        .messages
        .iter()
        .map(|m| (m.role.clone(), m.text.clone()))
        .collect()
}

fn pair(role: &str, text: &str) -> (String, String) {
    (role.to_owned(), text.to_owned())
}

#[test]
fn projects_historical_events_and_one_active_streaming_response() {
    let snapshot = mobile_session_snapshot(&record(), 12, None);
    assert_eq!(snapshot.sequence, 12);
    let triple = |r: &str, t: &str, s: &str| (r.to_owned(), t.to_owned(), s.to_owned());
    assert_eq!(
        shape(&snapshot),
        vec![
            triple("user", "Help", "complete"),
            triple("user", "Hello", "complete"),
            triple("assistant", "Earlier answer", "complete"),
            triple("assistant", "Streaming now", "streaming"),
        ]
    );
    assert!(snapshot.can_cancel);
    assert!(snapshot.pending_permissions.is_empty());
    assert!(!snapshot.can_continue);
}

#[test]
fn reopened_history_does_not_treat_response_text_as_transcript_truth() {
    let snapshot = mobile_session_snapshot(
        &MobileSessionRecord {
            state: "completed".into(),
            response_text: Some("transient buffer".into()),
            ..record()
        },
        2,
        None,
    );
    assert!(
        !snapshot
            .messages
            .iter()
            .any(|m| m.text == "transient buffer")
    );
    assert!(snapshot.can_continue);
    assert!(!snapshot.can_cancel);
}

#[test]
fn drops_pending_permissions_after_the_session_stops_awaiting_approval() {
    let events = vec![Event::new(
        "2026-09-22T09:00:01.000Z",
        "permission_requested",
        "Run tests",
    )];
    let awaiting = MobileSessionRecord {
        state: "awaiting_approval".into(),
        events: events.clone(),
        ..record()
    };
    assert_eq!(
        mobile_session_snapshot(&awaiting, 1, None)
            .pending_permissions
            .len(),
        1
    );
    for state in ["completed", "failed", "aborted"] {
        let stopped = MobileSessionRecord {
            state: state.into(),
            events: events.clone(),
            ..record()
        };
        assert!(
            mobile_session_snapshot(&stopped, 1, None)
                .pending_permissions
                .is_empty()
        );
    }
}

#[test]
fn projects_user_image_references_without_copying_large_base64_payloads() {
    let mut with_images = Event::new(
        "2026-09-22T09:00:01.000Z",
        "user_input_completed",
        "What is in this picture?",
    );
    with_images.attachments = Some(vec![
        json!({ "mimeType": "image/png", "dataBase64": "x".repeat(800_000) }),
        json!({ "mimeType": "image/jpeg", "dataBase64": "y".repeat(800_000) }),
    ]);
    let snapshot = mobile_session_snapshot(
        &MobileSessionRecord {
            state: "completed".into(),
            response_text: None,
            events: vec![
                Event::new(
                    "2026-09-22T09:00:00.000Z",
                    "user_input_completed",
                    "What is in this picture?",
                ),
                with_images,
            ],
            ..record()
        },
        1,
        None,
    );
    let messages: Vec<_> = snapshot
        .messages
        .iter()
        .filter(|m| m.text == "What is in this picture?")
        .collect();
    assert_eq!(messages.len(), 2);
    assert_eq!(
        messages[1].attachments,
        Some(vec![
            json!({ "eventIndex": 1, "attachmentIndex": 0, "mimeType": "image/png" }),
            json!({ "eventIndex": 1, "attachmentIndex": 1, "mimeType": "image/jpeg" }),
        ])
    );
    assert!(serde_json::to_string(&snapshot).expect("json").len() < 10_000);
}

#[test]
fn bounds_large_histories_so_a_mobile_snapshot_stays_transportable() {
    let events = (0..120)
        .map(|index| {
            let mut event = Event::new(
                &format!("2026-09-22T09:{:02}:{:02}.000Z", index / 60, index % 60),
                "message",
                &"x".repeat(20_000),
            );
            event.reasoning = Some("r".repeat(10_000));
            event
        })
        .collect();
    let snapshot = mobile_session_snapshot(
        &MobileSessionRecord {
            events,
            response_text: Some("y".repeat(30_000)),
            ..record()
        },
        1,
        None,
    );
    assert_eq!(snapshot.messages.len(), 80);
    assert!(
        snapshot
            .messages
            .iter()
            .all(|m| js_len(&m.text) <= 8_000 || m.status == "streaming")
    );
    assert!(
        snapshot
            .messages
            .iter()
            .any(|m| m.text.contains("content truncated for mobile"))
    );
    assert!(
        snapshot
            .response_text
            .as_deref()
            .is_some_and(|t| t.contains("content truncated for mobile"))
    );
    assert!(serde_json::to_string(&snapshot).expect("json").len() < 1_000_000);
}

#[test]
fn a_bounded_text_keeps_sixty_percent_head_and_the_tail() {
    let text: String = ('a'..='z').cycle().take(20_000).collect();
    let bounded = bounded_text(&text, 8_000);
    assert_eq!(js_len(&bounded), 8_000);
    let marker = "\n\n[…content truncated for mobile…]\n\n";
    let available = 8_000 - js_len(marker);
    let head = ((available as f64) * 0.6).ceil() as usize;
    assert!(bounded.starts_with(&text[..head]));
    assert!(bounded.ends_with(&text[text.len() - (available - head)..]));
}

#[test]
fn a_provider_handover_reaches_the_phone_as_a_notice_never_as_the_brief() {
    let brief = "# Session handover\n## Workspace\nWorking directory: /Users/someone/repo\nContinue the work described in Next steps.";
    let snapshot = mobile_session_snapshot(
        &MobileSessionRecord {
            state: "completed".into(),
            events: vec![
                Event::new("2026-09-22T09:00:01.000Z", "message", "Earlier answer"),
                Event::new(
                    "2026-09-22T09:00:02.000Z",
                    "model_change",
                    "Model changed to sonnet",
                )
                .with_detail("Previous model: haiku"),
                Event::new(
                    "2026-09-22T09:00:03.000Z",
                    "provider_handover",
                    "Handed over to Codex CLI (local)",
                )
                .with_detail(brief),
                Event::new("2026-09-22T09:00:04.000Z", "user_input_completed", brief),
                Event::new(
                    "2026-09-22T09:00:05.000Z",
                    "message",
                    "Picked up from the brief.",
                ),
            ],
            ..record()
        },
        1,
        None,
    );
    assert_eq!(
        roles(&snapshot),
        vec![
            pair("user", "Help"),
            pair("assistant", "Earlier answer"),
            pair("system", "Model changed to sonnet"),
            pair("system", "Handed over to Codex CLI (local)"),
            pair("assistant", "Picked up from the brief."),
        ]
    );
    let json = serde_json::to_string(&snapshot).expect("json");
    assert!(!json.contains("Working directory") && !json.contains("/Users/someone"));
}

const GADGET_REPLY: &str = "Two ways to fix it.\n```praxis-gadget\n{\"kind\":\"choice\",\"payload\":{\"question\":\"Which fix?\",\"options\":[{\"value\":\"a\",\"label\":\"Patch\"}]},\"actions\":[]}\n```";

#[test]
fn a_gadget_reply_reaches_the_phone_as_prose_plus_the_gadget_keyed_as_the_desktop_keys_it() {
    let seen = std::sync::Mutex::new(Vec::new());
    let resolver = |session_id: &str, key: &str, _text: &str| {
        seen.lock()
            .expect("seen")
            .push((session_id.to_owned(), key.to_owned()));
        (
            vec![
                json!({ "state": "active", "gadget": { "gadgetId": format!("{key}-1"), "kind": "choice" } }),
            ],
            0,
        )
    };
    let snapshot = mobile_session_snapshot(
        &MobileSessionRecord {
            state: "completed".into(),
            response_text: None,
            events: vec![
                Event::new("2026-09-22T09:00:00.000Z", "user_input_completed", "Hello"),
                Event::new("2026-09-22T09:00:00.500Z", "tool_start", "read file"),
                Event::new("2026-09-22T09:00:01.000Z", "message", "Looking").with_detail("Looking"),
                Event::new("2026-09-22T09:00:02.000Z", "message", "Two ways")
                    .with_detail(GADGET_REPLY),
            ],
            ..record()
        },
        3,
        Some(&resolver),
    );
    // Hello = 0, Looking = 1, the gadget reply = 2 (the tool event is not counted).
    assert_eq!(
        *seen.lock().expect("seen"),
        vec![("s1".to_owned(), "msg-2".to_owned())]
    );
    let last = snapshot.messages.last().expect("message");
    assert_eq!(last.text, "Two ways to fix it.");
    assert_eq!(
        last.gadgets
            .as_ref()
            .map(|g| g[0]["gadget"]["gadgetId"].clone()),
        Some(json!("msg-2-1"))
    );
}

#[test]
fn a_gadget_the_host_could_not_render_leaves_a_note() {
    let resolver = |_: &str, _: &str, _: &str| (Vec::new(), 1);
    let snapshot = mobile_session_snapshot(
        &MobileSessionRecord {
            state: "completed".into(),
            response_text: None,
            events: vec![
                Event::new("2026-09-22T09:00:02.000Z", "message", "x").with_detail(GADGET_REPLY),
            ],
            ..record()
        },
        1,
        Some(&resolver),
    );
    assert!(
        snapshot
            .messages
            .last()
            .is_some_and(|m| m.text.contains("could not be shown on the phone"))
    );
}

#[test]
fn a_streaming_reply_hides_a_gadget_fence_that_is_still_being_written() {
    let snapshot = mobile_session_snapshot(
        &MobileSessionRecord {
            response_text: Some("Here is the choice.\n```praxis-gadget\n{\"kind\":\"cho".into()),
            ..record()
        },
        2,
        None,
    );
    let streaming = snapshot.messages.iter().find(|m| m.status == "streaming");
    assert_eq!(
        streaming.map(|m| m.text.as_str()),
        Some("Here is the choice.")
    );
}

#[test]
fn a_gadget_answer_is_not_repeated_as_a_user_message() {
    let mut answer = Event::new(
        "2026-09-22T09:00:02.000Z",
        "user_input_completed",
        "Gadget response: Claude",
    );
    answer.gadget_answer = Some(true);
    let snapshot = mobile_session_snapshot(
        &MobileSessionRecord {
            events: vec![
                Event::new("2026-09-22T09:00:00.000Z", "user_input_completed", "Hello"),
                Event::new("2026-09-22T09:00:01.000Z", "message", "Pick one"),
                answer,
                Event::new("2026-09-22T09:00:03.000Z", "message", "Using Claude."),
            ],
            ..record()
        },
        12,
        None,
    );
    assert_eq!(
        roles(&snapshot),
        vec![
            pair("user", "Help"),
            pair("user", "Hello"),
            pair("assistant", "Pick one"),
            pair("assistant", "Using Claude."),
            pair("assistant", "Streaming now"),
        ]
    );
}

#[test]
fn home_activity_follows_the_latest_event_and_is_bounded() {
    let mut session = MobileSessionRecord {
        events: vec![Event::new(
            "2026-10-24T08:00:00.000Z",
            "tool_start",
            "Reading project files",
        )],
        ..record()
    };
    assert_eq!(
        mobile_session_snapshot(&session, 1, None)
            .summary
            .latest_activity
            .as_deref(),
        Some("Reading project files")
    );
    session.events.push(Event::new(
        "2026-10-24T08:01:00.000Z",
        "task_complete",
        &"x".repeat(1000),
    ));
    session.state = "completed".into();
    let finished = mobile_session_snapshot(&session, 2, None);
    assert_eq!(
        finished.summary.lifecycle,
        MobileSessionLifecycle::Completed
    );
    assert_eq!(finished.summary.latest_activity.map(|a| a.len()), Some(280));
}

#[test]
fn a_snapshot_serialises_in_the_ts_field_order() {
    let snapshot = mobile_session_snapshot(
        &MobileSessionRecord {
            state: "completed".into(),
            events: vec![],
            project_id: Some("p1".into()),
            ..record()
        },
        4,
        None,
    );
    assert_eq!(
        serde_json::to_string(&snapshot).expect("json"),
        r#"{"sessionId":"s1","sessionKey":"SESSION-1","projectId":"p1","workId":"SESSION-1","title":"Mobile session","lifecycle":"completed","provider":"openai","model":"gpt-5","mode":"chat","archived":false,"startedAt":"2026-09-22T09:00:00.000Z","sequence":4,"messages":[{"id":"s1:initial","role":"user","text":"Help","at":"2026-09-22T09:00:00.000Z","status":"complete"}],"pendingPermissions":[],"canContinue":true,"canCancel":false}"#
    );
    let back: MobileSessionSnapshot =
        serde_json::from_str(&serde_json::to_string(&snapshot).expect("json")).expect("parses");
    assert_eq!(back, snapshot);
}

#[test]
fn session_and_appearance_events_append_with_their_own_sequence() {
    let ledger = InMemoryMobileCommandLedger::default();
    let session = MobileSessionRecord {
        project_id: Some("p1".into()),
        ..record()
    };
    assert_eq!(
        append_mobile_session_event(&ledger, "host", &session, None),
        1
    );
    assert_eq!(
        append_mobile_appearance_event(&ledger, "host", &json!({ "themeId": "t" })),
        2
    );
    let events = ledger.replay(0, MOBILE_REPLAY_LIMIT);
    assert_eq!(events[0].event_id, "s1:1");
    assert_eq!(events[0].target.project_id.as_deref(), Some("p1"));
    assert_eq!(events[0].event["snapshot"]["sequence"], json!(1));
    assert_eq!(events[1].event_id, "appearance:2");
    assert_eq!(events[1].target, MobileTarget::host("host"));
    assert_eq!(events[1].event["type"], json!("host.appearance"));
}
