//! `GitLabApiService` and its merge-request helpers, against a local stub server.

use std::collections::HashMap;

use serde_json::json;

use super::{
    CreateGitLabIssueInput, GitLabApiConfig, GitLabApiError, GitLabApiService, GitLabBoardListKind,
    GitLabDiscussionNote, GitLabIssueListFilters, GitLabProjectRef, GitLabStateEvent,
    UpdateGitLabIssueInput, create_gitlab_handled_note_state, diff_gitlab_discussion_notes,
    flatten_gitlab_discussion_notes, format_gitlab_error, is_done_like_status,
    is_praxis_managed_merge_request_note, merge_request_matches_issue_key, parse_gitlab_remote_url,
    should_create_merge_request_for_status_change, wrap_praxis_managed_merge_request_note,
};
use crate::test_support::{MockResponse, MockServer, RecordedRequest};

fn config(base_url: &str) -> GitLabApiConfig {
    GitLabApiConfig {
        base_url: format!("{base_url}//"),
        project_path: "group/demo".to_string(),
        token: "glpat-secret".to_string(),
    }
}

fn form(request: &RecordedRequest) -> HashMap<String, String> {
    reqwest::Url::parse(&format!("http://form.invalid/?{}", request.body))
        .expect("the form body is a query string")
        .query_pairs()
        .into_owned()
        .collect()
}

#[test]
fn remote_urls_parse_from_ssh_and_url_forms() {
    let ssh = parse_gitlab_remote_url("git@gitlab.example.com:group/sub/demo.git").expect("ssh");
    assert_eq!(ssh.base_url, "https://gitlab.example.com");
    assert_eq!(ssh.project_path, "group/sub/demo");

    let https =
        parse_gitlab_remote_url(" https://gitlab.example.com:8443/group/demo.GIT ").expect("url");
    assert_eq!(https.base_url, "https://gitlab.example.com:8443");
    assert_eq!(https.project_path, "group/demo");

    assert_eq!(
        parse_gitlab_remote_url("  "),
        Err("The git remote URL is empty.".to_string())
    );
    assert_eq!(
        parse_gitlab_remote_url("not a url"),
        Err("Unsupported git remote URL format: not a url".to_string())
    );
}

#[test]
fn merge_requests_match_an_issue_key_only_as_a_whole_token() {
    assert!(merge_request_matches_issue_key(
        "Fix login",
        None,
        "feature/proj-12-login",
        "PROJ-12"
    ));
    assert!(merge_request_matches_issue_key(
        "PROJ-12: fix",
        Some(""),
        "",
        "proj-12"
    ));
    assert!(!merge_request_matches_issue_key(
        "PROJ-123 is different",
        Some("see PROJ-1234"),
        "x",
        "PROJ-12"
    ));
    assert!(merge_request_matches_issue_key(
        "t",
        Some("Closes a.b(1)"),
        "x",
        "a.b(1)"
    ));
}

#[test]
fn discussion_notes_flatten_sorted_and_diff_against_handled_state() {
    let discussions = vec![
        json!({ "id": "d2", "notes": [
            { "id": 3, "body": "later", "created_at": "2026-01-02T00:00:00Z", "author": { "name": "Ann" } }
        ]}),
        json!({ "id": "d1", "notes": [
            { "id": 1, "body": "first", "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T01:00:00Z",
              "system": true, "author": { "username": "bob", "name": "Bob" } },
            { "body": "no id" }
        ]}),
        json!({ "id": "d3" }),
    ];
    let notes = flatten_gitlab_discussion_notes(&discussions);
    assert_eq!(notes.len(), 2);
    assert_eq!(
        notes[0],
        GitLabDiscussionNote {
            id: "1".to_string(),
            discussion_id: "d1".to_string(),
            author: "bob".to_string(),
            body: "first".to_string(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T01:00:00Z".to_string(),
            system: true,
        }
    );
    assert_eq!(notes[1].author, "Ann");
    assert_eq!(notes[1].updated_at, "2026-01-02T00:00:00Z");

    let state = create_gitlab_handled_note_state(&notes[..1]);
    assert!(
        diff_gitlab_discussion_notes(Some(&state), &notes, true)
            .new_notes
            .is_empty()
    );
    let diff = diff_gitlab_discussion_notes(Some(&state), &notes, false);
    assert_eq!(diff.new_notes, vec![notes[1].clone()]);
    assert!(diff.updated_notes.is_empty());

    let mut edited = notes[0].clone();
    edited.updated_at = "2026-01-03T00:00:00Z".to_string();
    let diff = diff_gitlab_discussion_notes(Some(&state), &[edited.clone()], false);
    assert_eq!(diff.updated_notes, vec![edited]);
    assert_eq!(
        serde_json::to_value(&diff).expect("diff serializes")["updatedNotes"][0]["discussionId"],
        "d1"
    );
}

#[test]
fn status_and_marker_helpers_match_the_typescript() {
    assert!(is_done_like_status(Some(" Resolved "), None));
    assert!(is_done_like_status(Some("Shipped"), Some("done")));
    assert!(!is_done_like_status(None, None));
    assert!(should_create_merge_request_for_status_change(
        Some("In Review"),
        Some("Done"),
        None
    ));
    assert!(!should_create_merge_request_for_status_change(
        Some("Doing"),
        Some("Done"),
        None
    ));
    let wrapped = wrap_praxis_managed_merge_request_note("  hello ");
    assert_eq!(wrapped, "<!-- praxis-mr-reply -->\nhello");
    assert!(is_praxis_managed_merge_request_note(&format!(
        "  {wrapped}"
    )));
    assert!(!is_praxis_managed_merge_request_note("hello"));
}

#[test]
fn errors_flatten_gitlab_message_shapes() {
    assert_eq!(
        format_gitlab_error(401, "Unauthorized", r#"{"message":"401 Unauthorized"}"#),
        "GitLab request failed (HTTP 401 Unauthorized): 401 Unauthorized"
    );
    assert_eq!(
        format_gitlab_error(
            400,
            "Bad Request",
            r#"{"message":{"title":["can't be blank","is too short"],"labels":[]}}"#
        ),
        "GitLab request failed (HTTP 400 Bad Request): title: can't be blank; is too short"
    );
    assert_eq!(
        format_gitlab_error(403, "", r#"{"message":null,"error":"insufficient_scope"}"#),
        "GitLab request failed (HTTP 403): insufficient_scope"
    );
    assert_eq!(
        format_gitlab_error(500, "", r#""plain string""#),
        "GitLab request failed (HTTP 500): plain string"
    );
    assert_eq!(
        format_gitlab_error(502, "Bad Gateway", "<html>\n bad </html>"),
        "GitLab request failed (HTTP 502 Bad Gateway): <html> bad </html>"
    );
    assert_eq!(
        format_gitlab_error(500, "", " "),
        "GitLab request failed (HTTP 500)."
    );
}

#[test]
fn the_token_never_appears_in_debug_output() {
    let rendered = format!("{:?}", config("http://localhost"));
    assert!(!rendered.contains("glpat-secret"));
    assert!(rendered.contains("<redacted>"));
}

#[tokio::test]
async fn a_blank_project_path_fails_before_any_request() {
    let mut blank = config("http://127.0.0.1:9");
    blank.project_path = " ".to_string();
    let client = GitLabApiService::new(blank);
    let error = client.get_project(None).await.expect_err("no project");
    assert_eq!(error, GitLabApiError::ProjectNotConfigured);
    assert_eq!(error.to_string(), "No GitLab project path is configured.");
    assert_eq!(
        client.encode_project_ref(Some(&GitLabProjectRef::Id(42))),
        Ok("42".to_string())
    );
}

#[tokio::test]
async fn issue_lists_carry_gitlab_headers_and_follow_x_next_page() {
    let server = MockServer::start(|request| {
        if request.query_param("page").as_deref() == Some("2") {
            return MockResponse::json(
                &json!([{ "id": 2, "iid": 2, "title": "Second", "state": "closed" }]),
            )
            .with_header("x-next-page", " ");
        }
        MockResponse::json(&json!([{
            "id": 1, "iid": 1, "project_id": 9, "title": "First", "state": "opened",
            "labels": ["Doing", " ", 7], "assignees": [{ "username": "ann", "name": "Ann" }],
            "author": { "username": "bob" }, "milestone": { "title": "M1" },
            "references": { "full": "group/demo#1" }
        }]))
        .with_header("x-next-page", "2")
    })
    .await;
    let client = GitLabApiService::new(config(&server.base_url));
    let issues = client
        .list_issues(
            None,
            &GitLabIssueListFilters {
                labels: vec!["a".to_string(), "b".to_string()],
                weight: Some(3),
                ..GitLabIssueListFilters::default()
            },
        )
        .await
        .expect("issues");
    assert_eq!(issues.len(), 2);
    assert_eq!(issues[0].labels, vec!["Doing", "7"]);
    assert_eq!(issues[0].author_name.as_deref(), Some("bob"));
    assert_eq!(issues[0].milestone_title.as_deref(), Some("M1"));
    assert_eq!(
        issues[0]
            .references
            .as_ref()
            .and_then(|r| r.full.as_deref()),
        Some("group/demo#1")
    );
    assert_eq!(issues[1].state, "closed");

    let requests = server.requests();
    assert_eq!(requests.len(), 2);
    let first = &requests[0];
    assert_eq!(first.method, "GET");
    assert_eq!(first.path(), "/api/v4/projects/group%2Fdemo/issues");
    assert_eq!(first.query_param("labels").as_deref(), Some("a%2Cb"));
    assert_eq!(first.query_param("weight").as_deref(), Some("3"));
    assert_eq!(first.query_param("state").as_deref(), Some("all"));
    assert_eq!(first.query_param("page").as_deref(), Some("1"));
    assert_eq!(first.query_param("per_page").as_deref(), Some("100"));
    assert_eq!(first.query_param("assignee_username"), None);
    assert_eq!(first.header("private-token"), Some("glpat-secret"));
    assert_eq!(first.header("accept"), Some("application/json"));
    assert_eq!(first.header("user-agent"), Some("praxis"));
}

#[tokio::test]
async fn writes_send_form_bodies_with_only_the_set_fields() {
    let server = MockServer::start(|_| {
        MockResponse::json(&json!({ "id": 5, "iid": 4, "title": "t", "state": "opened" }))
    })
    .await;
    let client = GitLabApiService::new(config(&server.base_url));
    client
        .create_issue(
            &CreateGitLabIssueInput {
                title: "New".to_string(),
                ..CreateGitLabIssueInput::default()
            },
            Some(&GitLabProjectRef::Id(9)),
        )
        .await
        .expect("created");
    client
        .update_issue(
            4,
            &UpdateGitLabIssueInput {
                state_event: Some(GitLabStateEvent::Close),
                add_labels: Some(vec!["Done".to_string()]),
                remove_labels: Some(Vec::new()),
                assignee_ids: Some(Vec::new()),
                milestone_id: Some(0),
                ..UpdateGitLabIssueInput::default()
            },
            None,
        )
        .await
        .expect("updated");
    client
        .add_issue_comment(4, "  hi  ", None)
        .await
        .expect("comment");

    let requests = server.requests();
    assert_eq!(requests[0].method, "POST");
    assert_eq!(requests[0].path(), "/api/v4/projects/9/issues");
    assert_eq!(
        requests[0].header("content-type"),
        Some("application/x-www-form-urlencoded")
    );
    assert_eq!(
        form(&requests[0]),
        HashMap::from([("title".to_string(), "New".to_string())])
    );
    assert_eq!(requests[1].method, "PUT");
    assert_eq!(requests[1].path(), "/api/v4/projects/group%2Fdemo/issues/4");
    assert_eq!(
        form(&requests[1]),
        HashMap::from([
            ("state_event".to_string(), "close".to_string()),
            ("add_labels".to_string(), "Done".to_string()),
            ("assignee_ids".to_string(), "0".to_string()),
            ("milestone_id".to_string(), "0".to_string()),
        ])
    );
    assert_eq!(form(&requests[2])["body"], "hi");
}

#[tokio::test]
async fn boards_normalize_lists_in_position_order() {
    let server = MockServer::start(|_| {
        MockResponse::json(&json!({
            "id": 3, "name": "Dev", "hide_closed_list": true,
            "project": { "id": 9, "name": "Demo", "path": "demo", "web_url": "https://g/group/demo" },
            "creator": { "username": "ann" },
            "labels": ["scope", { "name": "team" }, { "name": "" }],
            "weight": 2,
            "lists": [
                { "id": 11, "position": 2, "iteration": { "id": "7", "title": "Sprint" } },
                { "id": 10, "position": 0, "label": { "name": "Doing" } },
                { "id": 12, "position": 1, "assignee": { "id": 4, "username": "ann", "name": "Ann" } },
                { "id": 13, "position": 3, "list_type": "backlog" },
                { "id": 14, "position": 4 }
            ]
        }))
    })
    .await;
    let board = GitLabApiService::new(config(&server.base_url))
        .get_board(3, Some(&GitLabProjectRef::from("other/proj")))
        .await
        .expect("board");
    assert_eq!(
        server.requests()[0].path(),
        "/api/v4/projects/other%2Fproj/boards/3"
    );
    assert_eq!(board.project.path_with_namespace, "demo");
    assert_eq!(board.web_url.as_deref(), Some("https://g/group/demo"));
    assert_eq!(board.created_by.as_deref(), Some("ann"));
    assert!(board.hide_closed_list && !board.hide_backlog_list);
    assert_eq!(board.labels, vec!["scope", "team"]);
    assert_eq!(board.weight, Some(2));
    let titles: Vec<&str> = board.lists.iter().map(|l| l.title.as_str()).collect();
    assert_eq!(titles, vec!["Doing", "Ann", "Sprint", "backlog", "List 14"]);
    assert_eq!(board.lists[0].kind, Some(GitLabBoardListKind::Label));
    assert_eq!(board.lists[1].assignee_id, Some(4));
    assert_eq!(board.lists[2].iteration_id, Some(7));
    assert_eq!(board.lists[3].kind, None);
    let serialized = serde_json::to_value(&board).expect("board serializes");
    assert_eq!(serialized["project"]["id"], 9);
    assert_eq!(serialized["lists"][0]["labelName"], "Doing");
    assert_eq!(serialized["hideClosedList"], true);
}

#[tokio::test]
async fn find_users_falls_back_to_a_search_when_no_username_matches() {
    let server = MockServer::start(|request| {
        if request.query_param("username").is_some() {
            MockResponse::json(&json!([]))
        } else {
            MockResponse::json(&json!([{ "id": 8, "username": "annie", "name": "Ann" }]))
        }
    })
    .await;
    let users = GitLabApiService::new(config(&server.base_url))
        .find_users(" Ann ")
        .await
        .expect("users");
    assert_eq!(users[0].id, 8);
    let requests = server.requests();
    assert_eq!(requests[0].query_param("username").as_deref(), Some("Ann"));
    assert_eq!(requests[1].query_param("search").as_deref(), Some("Ann"));
}

#[tokio::test]
async fn merge_requests_for_an_issue_are_filtered_to_whole_key_matches() {
    let server = MockServer::start(|_| {
        MockResponse::json(&json!([
            { "project_id": 9, "iid": 1, "title": "PROJ-1 fix", "source_branch": "a", "target_branch": "main",
              "state": "opened", "web_url": "https://g/mr/1", "diff_refs": { "head_sha": "abc" } },
            { "iid": 2, "title": "PROJ-10 other", "source_branch": "b" }
        ]))
    })
    .await;
    let merge_requests = GitLabApiService::new(config(&server.base_url))
        .list_merge_requests_for_issue("PROJ-1")
        .await
        .expect("merge requests");
    assert_eq!(merge_requests.len(), 1);
    assert_eq!(merge_requests[0].head_sha.as_deref(), Some("abc"));
    assert_eq!(
        server.requests()[0].query_param("search").as_deref(),
        Some("PROJ-1")
    );
}

#[tokio::test]
async fn an_error_status_keeps_its_code_and_gitlab_message() {
    let server = MockServer::start(|_| {
        MockResponse::status_json(401, &json!({ "message": "401 Unauthorized" }))
    })
    .await;
    let error = GitLabApiService::new(config(&server.base_url))
        .get_current_user()
        .await
        .expect_err("401 fails");
    assert_eq!(error.status(), Some(401));
    assert_eq!(
        error.to_string(),
        "GitLab request failed (HTTP 401 Unauthorized): 401 Unauthorized"
    );
}
