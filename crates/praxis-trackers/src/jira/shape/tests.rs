use super::*;
use serde_json::json;
const BASE: &str = "https://acme.atlassian.net";

#[test]
fn full_jira_hit_preserves_fields_and_raw() {
    let raw = json!({"id":"10001","key":"DEMO-1","self":"self-url","fields": {
        "summary":"Bootstrap the board","status":{"name":"In Progress","statusCategory":{"name":"In Progress"}},
        "issuetype":{"name":"Story"},"project":{"key":"DEMO","name":"Demo Project"},
        "parent":{"key":"DEMO-0","fields":{"summary":"Parent","issuetype":{"name":"Epic"}}},
        "assignee":{"displayName":"Alex Agent"},"reporter":{"displayName":"Sam Owner","accountId":"aid-2"},
        "priority":{"name":"High"},"created":"created","updated":"updated","description":"Wire the board up."}});
    let issue = normalize_issue(&raw, BASE).expect("valid issue");
    assert_eq!(issue.key, "DEMO-1");
    assert_eq!(issue.summary, "Bootstrap the board");
    assert_eq!(issue.status, "In Progress");
    assert_eq!(issue.status_category.as_deref(), Some("In Progress"));
    assert_eq!(issue.issue_type, "Story");
    assert_eq!(issue.project_key, "DEMO");
    assert_eq!(issue.project_name.as_deref(), Some("Demo Project"));
    assert_eq!(
        issue.parent_issue.expect("parent").issue_type.as_deref(),
        Some("Epic")
    );
    assert_eq!(issue.assignee.as_deref(), Some("Alex Agent"));
    assert_eq!(
        issue.reporter_mention.as_deref(),
        Some("[~accountid:aid-2]")
    );
    assert_eq!(issue.description.as_deref(), Some("Wire the board up."));
    assert_eq!(issue.raw, Some(raw));
}

#[test]
fn sparse_flat_and_scalar_enum_hits() {
    let issue = normalize_issue(&json!({"key":"DEMO-9","fields":{}}), BASE).expect("sparse issue");
    assert_eq!(issue.summary, "(No summary)");
    assert_eq!(issue.status, "Unknown");
    assert_eq!(issue.issue_type, "Issue");
    assert_eq!(issue.project_key, "");
    assert!(issue.status_category.is_none());
    let issue = normalize_issue(
        &json!({"key":"DEMO-2","summary":"Flat","status":"Done","issuetype":"Bug"}),
        BASE,
    )
    .expect("flat issue");
    assert_eq!(issue.summary, "Flat");
    assert_eq!(issue.status, "Done");
    assert_eq!(issue.issue_type, "Bug");
}

#[test]
fn malformed_payloads_do_not_make_issues() {
    for raw in [
        Value::Null,
        json!("DEMO-1"),
        json!([]),
        json!({"key":""}),
        json!({"fields":{}}),
    ] {
        assert!(normalize_issue(&raw, BASE).is_none());
        assert!(normalize_project(&raw).is_none());
        assert!(normalize_parent_issue(&raw).is_none());
        assert!(normalize_transition(&raw).is_none());
        assert!(normalize_comment(&raw).is_none());
    }
}

#[test]
fn adf_flattening_preserves_plain_strings_and_collapses_nodes() {
    assert_eq!(
        extract_description(&json!("  keep\n  spacing  ")).as_deref(),
        Some("  keep\n  spacing  ")
    );
    assert_eq!(extract_description(&json!({"type":"doc","content":[{"type":"paragraph","content":[{"text":"Hello"},{"text":"  world\n"}]},{"content":[{"text":"Next"}]}]})).as_deref(), Some("Hello world Next"));
    assert_eq!(
        extract_description(&json!(["a",null,"",{"text":"b"}])).as_deref(),
        Some("a b")
    );
    assert_eq!(extract_description(&json!([])).as_deref(), Some(""));
    assert!(extract_description(&json!({"text":" \u{feff} "})).is_none());
    assert!(extract_description(&json!(42)).is_none());
}

#[test]
fn parent_and_project_fallbacks() {
    let parent = normalize_parent_issue(&json!({"key":"DEMO-0","summary":"Epic","issuetype":"Epic","description":{"content":[{"text":"Hello"}]}})).expect("parent");
    assert_eq!(parent.summary.as_deref(), Some("Epic"));
    assert_eq!(parent.issue_type.as_deref(), Some("Epic"));
    assert_eq!(parent.description.as_deref(), Some("Hello"));
    let project = normalize_project(&json!({"id":1,"key":"DEMO"})).expect("project");
    assert_eq!(project.id.as_deref(), Some("1"));
    assert_eq!(project.name, "DEMO");
    assert!(normalize_project(&json!({"key":"DEMO","name":""})).is_none());
}

#[test]
fn reporter_mentions_and_display_name_precedence() {
    for (reporter, mention) in [
        (
            json!({"accountId":" aid ","name":"legacy"}),
            "[~accountid:aid]",
        ),
        (json!({"name":" sam "}), "[~sam]"),
        (json!({"key":"legacy"}), "[~legacy]"),
    ] {
        let issue =
            normalize_issue(&json!({"key":"D-1","reporter":reporter}), BASE).expect("issue");
        assert_eq!(issue.reporter_mention.as_deref(), Some(mention));
    }
    assert_eq!(
        user_name(&json!({"displayName":"","name":"fallback"})),
        Some(String::new())
    );
}

#[test]
fn comments_accept_adf_and_scalars_but_reject_blank() {
    let raw = json!({"id":123,"author":{"displayName":"Alex"},"body":{"content":[{"text":"Hello"}]},"created":"then"});
    let comment = normalize_comment(&raw).expect("comment");
    assert_eq!(comment.id.as_deref(), Some("123"));
    assert_eq!(comment.body, "Hello");
    assert_eq!(comment.author.as_deref(), Some("Alex"));
    assert_eq!(comment.raw, Some(raw));
    assert_eq!(
        normalize_comment(&json!({"body":false}))
            .expect("scalar")
            .body,
        "false"
    );
    assert!(normalize_comment(&json!({"body":"  "})).is_none());
}

#[test]
fn transitions_require_id_and_name_and_retain_raw() {
    let raw = json!({"id":31,"name":"Done","to":{"name":"Complete"}});
    let t = normalize_transition(&raw).expect("transition");
    assert_eq!(t.id, "31");
    assert_eq!(t.to_status.as_deref(), Some("Complete"));
    assert_eq!(t.raw, Some(raw));
    assert!(normalize_transition(&json!({"id":"1"})).is_none());
}

#[test]
fn array_and_key_wrappers_match_mcp_variants() {
    assert_eq!(
        extract_array(&json!([1, 2]), &["issues"]),
        &[json!(1), json!(2)]
    );
    assert_eq!(
        extract_array(&json!({"issues":[3],"values":[4]}), &["issues"]),
        &[json!(3)]
    );
    assert_eq!(
        extract_array(&json!({"values":[4]}), &["issues"]),
        &[json!(4)]
    );
    assert!(extract_array(&Value::Null, &["issues"]).is_empty());
    assert_eq!(
        extract_issue_key(&json!({"key":"DEMO-1","id":123})).as_deref(),
        Some("DEMO-1")
    );
    assert_eq!(
        extract_issue_key(&json!({"id":123})).as_deref(),
        Some("123")
    );
}

#[test]
fn configured_board_order_wins_verbatim() {
    assert_eq!(
        build_board_status_order(&[" B ".into(), "B".into()], &["Done".into()], &[]),
        vec![" B ", "B"]
    );
}

#[test]
fn backlog_first_then_workflow_then_leftovers() {
    let strings = |values: &[&str]| values.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
    assert_eq!(
        build_board_status_order(
            &[],
            &strings(&["To Do", "In Progress", "Backlog", "Done"]),
            &strings(&["Done", "On Hold", "To Do", " "])
        ),
        strings(&["Backlog", "To Do", "In Progress", "Done", "On Hold"])
    );
}

#[test]
fn category_ranks_and_url_slashes() {
    for (name, rank) in [
        ("To Do", 0),
        ("todo", 0),
        ("In Progress", 1),
        ("indeterminate", 1),
        ("Done", 2),
        ("Backlog", 3),
    ] {
        assert_eq!(status_category_rank(Some(name)), rank);
    }
    assert_eq!(status_category_rank(None), 3);
    assert_eq!(
        derive_browse_url(&format!("{BASE}/"), "D-1"),
        format!("{BASE}/browse/D-1")
    );
    assert_eq!(
        derive_browse_url(&format!("{BASE}//"), "D-1"),
        format!("{BASE}//browse/D-1")
    );
    assert_eq!(normalize_field_name(" In__Progress-- "), "in progress");
}
