//! Ports `github/githubBoardService.test.ts`, plus board synthesis and transition coverage
//! against a local stub server.

use std::sync::Arc;

use praxis_contracts::{
    Board, BoardFilters, CreateBoardInput, CreateIssueInput, IssueAttachment, IssueFilters,
    UpdateBoardInput, UpdateIssueInput,
};
use reqwest::Client;
use serde_json::{Value, json};

use super::{GitHubBoardService, extract_status_label_value, parse_github_issue_key};
use crate::github::config_store::{GitHubBoardServiceOptions, StaticGitHubConfig};
use crate::issue_tracker_service::{IssueTrackerService, SilentLogSink};
use crate::test_support::{MockResponse, MockServer, RecordedRequest};

fn no_environment_token() -> Option<String> {
    None
}

fn config(api_url: &str) -> StaticGitHubConfig {
    StaticGitHubConfig {
        api_url: api_url.to_string(),
        owner: "octocat".to_string(),
        repo: "demo".to_string(),
        api_key: "ghp-test".to_string(),
        ..StaticGitHubConfig::default()
    }
}

fn service_with(config: StaticGitHubConfig) -> GitHubBoardService {
    GitHubBoardService::with_options(
        Arc::new(config),
        Arc::new(SilentLogSink),
        Client::new(),
        GitHubBoardServiceOptions {
            secrets: None,
            environment_token: no_environment_token,
        },
    )
}

/// A server that answers nothing useful: the refusal tests assert it saw no request.
async fn unreachable_server() -> MockServer {
    MockServer::start(|_| MockResponse::text(500, "the backend should have refused first")).await
}

fn issue(number: u64, state: &str, labels: &[&str], updated: &str) -> Value {
    json!({
        "id": 1000 + number,
        "number": number,
        "title": format!("Issue {number}"),
        "state": state,
        "labels": labels.iter().map(|name| json!({ "name": name })).collect::<Vec<_>>(),
        "html_url": format!("https://github.com/octocat/demo/issues/{number}"),
        "user": { "login": "octocat" },
        "assignees": [{ "login": "hubot", "name": "Hubot" }, { "login": "monalisa" }],
        "updated_at": updated,
        "body": format!("Body of {number}")
    })
}

fn repo_router(request: &RecordedRequest) -> MockResponse {
    let path = request.path();
    match (request.method.as_str(), path) {
        ("GET", "/repos/octocat/demo") => {
            MockResponse::json(&json!({ "full_name": "octocat/demo", "name": "demo" }))
        }
        ("GET", "/repos/octocat/demo/labels") => MockResponse::json(&json!([
            { "name": "status: Review" },
            { "name": "Status:  In Progress" },
            { "name": "bug" },
            { "name": "status: review" }
        ])),
        ("GET", "/repos/octocat/demo/issues") => MockResponse::json(&json!([
            issue(1, "open", &["status: in progress", "bug"], "2026-01-02T00:00:00Z"),
            issue(2, "closed", &["status: Review"], "2026-01-03T00:00:00Z"),
            issue(3, "open", &["enhancement"], "2026-01-01T00:00:00Z"),
            { "id": 9, "number": 9, "title": "A PR", "state": "open", "pull_request": {} }
        ])),
        ("GET", "/repos/octocat/demo/issues/1") => MockResponse::json(&issue(
            1,
            "open",
            &["status: in progress", "bug"],
            "2026-01-02T00:00:00Z",
        )),
        ("GET", "/repos/octocat/demo/issues/1/comments") => MockResponse::json(&json!([
            { "id": 77, "body": "Looks good", "user": { "login": "hubot" }, "created_at": "2026-01-02T00:00:00Z" }
        ])),
        ("PATCH", "/repos/octocat/demo/issues/1") | ("POST", "/repos/octocat/demo/issues") => {
            MockResponse::json(&issue(1, "open", &[], "2026-01-02T00:00:00Z"))
        }
        ("POST", "/repos/octocat/demo/issues/1/comments") => {
            MockResponse::status_json(201, &json!({ "id": 78 }))
        }
        ("GET", "/user") => MockResponse::json(&json!({ "login": " octocat " })),
        _ => MockResponse::status_json(404, &json!({ "message": "Not Found" })),
    }
}

fn board_filters() -> IssueFilters {
    IssueFilters {
        board_id: Some("github:octocat/demo".to_string()),
        ..IssueFilters::default()
    }
}

// ── Refusals: folder's voice, not GitLab's "not implemented yet" ────────────

#[tokio::test]
async fn create_board_refuses_by_naming_the_repository_as_the_board_without_touching_the_network() {
    let server = unreachable_server().await;
    let error = service_with(config(&server.base_url))
        .create_board(&CreateBoardInput {
            name: "x".to_string(),
            project_key: "octocat/demo".to_string(),
            project_name: None,
            live_folder_path: None,
        })
        .await
        .expect_err("create board refuses");
    assert!(error.contains("does not support creating boards"));
    assert!(error.contains("repository is the board"));
    assert!(server.requests().is_empty());
}

#[tokio::test]
async fn update_board_refuses_the_same_way() {
    let error = service_with(config(""))
        .update_board("github:octocat/demo", &UpdateBoardInput::default())
        .await
        .expect_err("update board refuses");
    assert!(error.contains("does not support updating boards"));
    assert!(error.contains("repository is the board"));
}

#[tokio::test]
async fn delete_board_refuses_by_naming_the_alternative() {
    let error = service_with(config(""))
        .delete_board("github:octocat/demo")
        .await
        .expect_err("delete board refuses");
    assert!(error.contains("does not support deleting boards. Remove the connection instead."));
}

#[tokio::test]
async fn delete_issue_refuses_by_naming_the_alternative_never_not_implemented_yet() {
    let error = service_with(config(""))
        .delete_issue("octocat/demo#1")
        .await
        .expect_err("delete issue refuses");
    assert!(error.contains("does not support deleting issues. Close the issue instead."));
    assert!(!error.to_lowercase().contains("not implemented yet"));
}

#[tokio::test]
async fn attach_file_refuses_by_naming_the_alternative() {
    let error = service_with(config(""))
        .attach_file("octocat/demo#1", "/tmp/x.png", None)
        .await
        .expect_err("attach refuses");
    assert!(error.contains("does not support attachments"));
    assert!(error.contains("Add files as links"));
}

#[tokio::test]
async fn download_attachment_refuses_the_same_way() {
    let attachment = IssueAttachment {
        id: None,
        file_name: "x.png".to_string(),
        mime_type: None,
        size_bytes: None,
        content_url: None,
        thumbnail_url: None,
        created: None,
        author: None,
        raw: None,
    };
    let error = service_with(config(""))
        .download_attachment("octocat/demo#1", &attachment, "/tmp/x.png")
        .await
        .expect_err("download refuses");
    assert!(error.contains("does not support attachments"));
    assert!(error.contains("Add files as links"));
}

// ── Configuration failures also surface before any network attempt ─────────

#[tokio::test]
async fn a_missing_pat_throws_a_clear_message_and_never_falls_back_to_empty_data() {
    let server = unreachable_server().await;
    let error = service_with(StaticGitHubConfig {
        api_key: String::new(),
        ..config(&server.base_url)
    })
    .get_issue("octocat/demo#1")
    .await
    .expect_err("a missing token fails");
    assert_eq!(error, "No GitHub personal access token is configured.");
    assert!(server.requests().is_empty());
}

#[tokio::test]
async fn the_environment_token_is_the_last_resort() {
    fn environment_token() -> Option<String> {
        Some(" ghp-from-env ".to_string())
    }
    let server = MockServer::start(repo_router).await;
    let service = GitHubBoardService::with_options(
        Arc::new(StaticGitHubConfig {
            api_key: "  ".to_string(),
            ..config(&server.base_url)
        }),
        Arc::new(SilentLogSink),
        Client::new(),
        GitHubBoardServiceOptions {
            secrets: None,
            environment_token,
        },
    );
    service.check_connection().await.expect("connected");
    assert_eq!(
        server.requests()[0].header("authorization"),
        Some("Bearer ghp-from-env")
    );
}

#[tokio::test]
async fn a_missing_owner_or_repo_throws_a_clear_message() {
    let error = service_with(StaticGitHubConfig {
        owner: String::new(),
        ..config("")
    })
    .check_connection()
    .await
    .expect_err("a missing owner fails");
    assert_eq!(
        error,
        "Configure a GitHub repository owner and name for this connection."
    );
}

// ── An invalid/expired token surfaces GitHub's own error text ───────────────

#[tokio::test]
async fn check_connection_surfaces_a_401_from_github_verbatim_rather_than_reporting_false_success()
{
    let server = MockServer::start(|_| {
        MockResponse::status_json(401, &json!({ "message": "Bad credentials" }))
    })
    .await;
    let error = service_with(config(&server.base_url))
        .check_connection()
        .await
        .expect_err("401 fails");
    assert!(
        error.contains("GitHub request failed (HTTP 401 Unauthorized): Bad credentials"),
        "{error}"
    );
}

#[tokio::test]
async fn a_404_for_an_unknown_repository_surfaces_githubs_own_error_text() {
    let server =
        MockServer::start(|_| MockResponse::status_json(404, &json!({ "message": "Not Found" })))
            .await;
    let error = service_with(config(&server.base_url))
        .check_connection()
        .await
        .expect_err("404 fails");
    assert!(
        error.contains("GitHub request failed (HTTP 404 Not Found): Not Found"),
        "{error}"
    );
}

// ── Board synthesis, issues and transitions ─────────────────────────────────

#[test]
fn status_labels_and_issue_keys_parse_like_the_typescript() {
    assert_eq!(
        extract_status_label_value(" Status:  In Progress ").as_deref(),
        Some("In Progress")
    );
    assert_eq!(extract_status_label_value("bug"), None);
    assert_eq!(extract_status_label_value("status:"), None);
    assert_eq!(parse_github_issue_key("octocat/demo#42"), Ok(42));
    assert_eq!(
        parse_github_issue_key("octocat/demo-42"),
        Err("Invalid GitHub issue key: octocat/demo-42".to_string())
    );
}

#[tokio::test]
async fn check_connection_names_the_status_columns_it_found() {
    let server = MockServer::start(repo_router).await;
    let check = service_with(config(&format!("{}//", server.base_url)))
        .check_connection()
        .await
        .expect("connected");
    assert_eq!(
        check.message,
        "Connected to GitHub repository octocat/demo. 3 status column(s) found: In Progress, review, Review."
    );
    assert_eq!(check.tool_count, 2);
    assert_eq!(check.project_count, Some(1));
    assert_eq!(check.server_name.as_deref(), Some(server.base_url.as_str()));
}

#[tokio::test]
async fn the_board_has_backlog_status_columns_and_closed_and_files_issues_by_label() {
    let server = MockServer::start(repo_router).await;
    let service = service_with(config(&server.base_url));
    let boards = service
        .get_boards(&BoardFilters::default())
        .await
        .expect("boards");
    assert_eq!(boards.len(), 1);
    let board: &Board = &boards[0];
    assert_eq!(board.id, "github:octocat/demo");
    assert_eq!(board.board_type, "issue-board");
    assert_eq!(
        board.location_name.as_deref(),
        Some(server.base_url.as_str())
    );

    let details = service.get_board_details(board).await.expect("details");
    let names: Vec<&str> = details.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(
        names,
        vec!["Backlog", "In Progress", "review", "Review", "Closed"]
    );
    assert_eq!(
        details.column_status_order,
        Some(names.iter().map(|n| (*n).to_string()).collect())
    );
    let keys_in = |name: &str| -> Vec<String> {
        details
            .columns
            .iter()
            .find(|c| c.name == name)
            .map(|c| c.issues.iter().map(|i| i.key.clone()).collect())
            .unwrap_or_default()
    };
    assert_eq!(keys_in("In Progress"), vec!["octocat/demo#1"]);
    assert_eq!(keys_in("Backlog"), vec!["octocat/demo#3"]);
    assert_eq!(keys_in("Closed"), vec!["octocat/demo#2"]);
    assert_eq!(details.issues.len(), 3, "pull requests are filtered out");

    let first = serde_json::to_value(&details.issues[0]).expect("summary serializes");
    assert_eq!(first["id"], json!("1001"));
    assert_eq!(first["status"], json!("In Progress"));
    assert_eq!(first["issueType"], json!("issue"));
    assert_eq!(first["projectKey"], json!("octocat/demo"));
    assert_eq!(first["projectName"], json!("demo"));
    assert_eq!(first["assignee"], json!("Hubot, monalisa"));
    assert_eq!(first["reporter"], json!("octocat"));
    assert!(first.get("statusCategory").is_none());
    assert_eq!(details.columns[0].status_category.as_deref(), Some("todo"));

    let labels_fetches = server
        .requests()
        .iter()
        .filter(|r| r.path().ends_with("/labels"))
        .count();
    service
        .get_board_details(board)
        .await
        .expect("details again");
    let labels_fetches_after = server
        .requests()
        .iter()
        .filter(|r| r.path().ends_with("/labels"))
        .count();
    assert_eq!(
        labels_fetches, labels_fetches_after,
        "status labels are cached"
    );
}

#[tokio::test]
async fn board_filters_can_exclude_the_board() {
    let service = service_with(config(""));
    let by_type = BoardFilters {
        types: vec!["plan".to_string()],
        ..BoardFilters::default()
    };
    assert!(
        service
            .get_boards(&by_type)
            .await
            .expect("boards")
            .is_empty()
    );
    let by_search = BoardFilters {
        search_text: "API.GITHUB".to_string(),
        ..BoardFilters::default()
    };
    assert_eq!(
        service.get_boards(&by_search).await.expect("boards").len(),
        1
    );
}

#[tokio::test]
async fn get_issues_filters_sorts_and_pages_in_memory_and_needs_a_board() {
    let server = MockServer::start(repo_router).await;
    let service = service_with(config(&server.base_url));

    let unloaded = service
        .get_issues(&IssueFilters::default(), 0, 25)
        .await
        .expect("no board");
    assert!(unloaded.issues.is_empty());
    assert_eq!(unloaded.total, Some(0));
    assert!(server.requests().is_empty());

    let page = service
        .get_issues(&board_filters(), 0, 2)
        .await
        .expect("first page");
    let keys: Vec<&str> = page.issues.iter().map(|i| i.key.as_str()).collect();
    assert_eq!(keys, vec!["octocat/demo#2", "octocat/demo#1"]);
    assert_eq!(page.total, Some(3));
    assert!(page.has_more);

    let filtered = service
        .get_issues(
            &IssueFilters {
                statuses: vec!["Backlog".to_string()],
                search_text: "BODY OF".to_string(),
                ..board_filters()
            },
            0,
            25,
        )
        .await
        .expect("filtered");
    assert_eq!(filtered.issues.len(), 1);
    assert_eq!(filtered.issues[0].key, "octocat/demo#3");

    let metadata = service
        .get_filter_metadata(&IssueFilters {
            statuses: vec!["Closed".to_string()],
            ..board_filters()
        })
        .await
        .expect("metadata");
    assert_eq!(metadata.statuses, vec!["Backlog", "Closed", "In Progress"]);
    assert_eq!(metadata.issue_types, vec!["issue"]);
}

#[tokio::test]
async fn get_issue_includes_comments_and_moves_to_every_other_column() {
    let server = MockServer::start(repo_router).await;
    let details = service_with(config(&server.base_url))
        .get_issue("octocat/demo#1")
        .await
        .expect("issue");
    assert_eq!(details.summary.status, "In Progress");
    let comments = details.comments.expect("comments");
    assert_eq!(comments[0].id.as_deref(), Some("77"));
    assert_eq!(comments[0].author.as_deref(), Some("hubot"));
    let transitions = details.transitions.expect("transitions");
    let ids: Vec<&str> = transitions.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(
        ids,
        vec![
            "github:backlog",
            "github:status:review",
            "github:status:Review",
            "github:closed"
        ]
    );
    assert_eq!(transitions[0].name, "Move to Backlog");
    assert_eq!(transitions[0].to_status.as_deref(), Some("Backlog"));
}

#[tokio::test]
async fn transitions_replace_the_status_label_and_set_the_native_state() {
    let server = MockServer::start(repo_router).await;
    let service = service_with(config(&server.base_url));
    service
        .transition_issue("octocat/demo#1", "github:status:Review")
        .await
        .expect("moved to review");
    service
        .transition_issue("octocat/demo#1", "github:closed")
        .await
        .expect("closed");
    let error = service
        .transition_issue("octocat/demo#1", "github:status:Nope")
        .await
        .expect_err("unknown column");
    assert_eq!(error, "Unknown GitHub board column: status:Nope");

    let patches: Vec<Value> = server
        .requests()
        .iter()
        .filter(|r| r.method == "PATCH")
        .map(RecordedRequest::json_body)
        .collect();
    assert_eq!(
        patches,
        vec![
            json!({ "state": "open", "labels": ["bug", "status: review"] }),
            json!({ "state": "closed", "labels": ["bug"] })
        ]
    );
}

#[tokio::test]
async fn issue_creation_is_gated_and_needs_a_summary() {
    let server = MockServer::start(repo_router).await;
    let input = CreateIssueInput {
        summary: "  New issue  ".to_string(),
        description: Some("   ".to_string()),
        ..CreateIssueInput::default()
    };
    let refused = service_with(config(&server.base_url))
        .create_issue(&input)
        .await
        .expect_err("creation is off by default");
    assert!(refused.starts_with("Issue creation is disabled for this repository."));
    assert!(server.requests().is_empty());

    let allowed = service_with(StaticGitHubConfig {
        allow_issue_creation: true,
        ..config(&server.base_url)
    });
    let blank = allowed
        .create_issue(&CreateIssueInput {
            summary: " ".to_string(),
            ..CreateIssueInput::default()
        })
        .await
        .expect_err("blank summary");
    assert_eq!(blank, "Summary cannot be empty.");

    let created = allowed.create_issue(&input).await.expect("created");
    assert_eq!(created.summary.key, "octocat/demo#1");
    let post = server
        .requests()
        .into_iter()
        .find(|r| r.method == "POST")
        .expect("a create request");
    assert_eq!(post.json_body(), json!({ "title": "New issue" }));
}

#[tokio::test]
async fn editing_supports_summary_description_and_assignee_only() {
    let server = MockServer::start(repo_router).await;
    let service = service_with(config(&server.base_url));
    let error = service
        .update_issue(
            "octocat/demo#1",
            &UpdateIssueInput {
                parent_key: Some(None),
                priority: Some("High".to_string()),
                idea_transcript: Some(String::new()),
                ..UpdateIssueInput::default()
            },
        )
        .await
        .expect_err("unsupported fields");
    assert_eq!(
        error,
        "GitHub issue editing currently supports summary, description, and assignee only. Unsupported fields: parentKey, priority, ideaTranscript."
    );
    assert!(server.requests().is_empty());

    service
        .update_issue(
            "octocat/demo#1",
            &UpdateIssueInput {
                summary: Some(" Renamed ".to_string()),
                assignee: Some(Some("hubot, ,monalisa".to_string())),
                ..UpdateIssueInput::default()
            },
        )
        .await
        .expect("updated");
    service
        .update_issue(
            "octocat/demo#1",
            &UpdateIssueInput {
                description: Some("New body".to_string()),
                assignee: Some(None),
                ..UpdateIssueInput::default()
            },
        )
        .await
        .expect("unassigned");
    let patches: Vec<Value> = server
        .requests()
        .iter()
        .filter(|r| r.method == "PATCH")
        .map(RecordedRequest::json_body)
        .collect();
    assert_eq!(
        patches,
        vec![
            json!({ "title": "Renamed", "assignees": ["hubot", "monalisa"] }),
            json!({ "body": "New body", "assignees": [] })
        ]
    );
}

#[tokio::test]
async fn comments_are_trimmed_and_an_empty_one_is_refused() {
    let server = MockServer::start(repo_router).await;
    let service = service_with(config(&server.base_url));
    assert_eq!(
        service.add_comment("octocat/demo#1", "   ").await,
        Err("Comment cannot be empty.".to_string())
    );
    service
        .add_comment("octocat/demo#1", "  Ship it  ")
        .await
        .expect("commented");
    let post = server
        .requests()
        .into_iter()
        .find(|r| r.method == "POST")
        .expect("a comment request");
    assert_eq!(post.json_body(), json!({ "body": "Ship it" }));
}

#[tokio::test]
async fn the_self_assignee_label_is_the_trimmed_login_and_reset_clears_the_cache() {
    let server = MockServer::start(repo_router).await;
    let service = service_with(config(&server.base_url));
    assert_eq!(
        service
            .get_self_assignee_label()
            .await
            .expect("label")
            .as_deref(),
        Some("octocat")
    );
    service.check_connection().await.expect("connected");
    service.reset().await.expect("reset");
    service.check_connection().await.expect("connected again");
    let label_fetches = server
        .requests()
        .iter()
        .filter(|r| r.path().ends_with("/labels"))
        .count();
    assert_eq!(label_fetches, 2);
}
