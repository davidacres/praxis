//! Ports `gitlab/gitLabBoardService.test.ts`, plus board loading, transition, editing and
//! config-resolution coverage against a local stub server.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use praxis_contracts::{
    Board, BoardFilters, CreateBoardInput, CreateIssueInput, IssueAttachment, IssueFilters,
    UpdateBoardInput, UpdateIssueInput,
};
use reqwest::Client;
use serde_json::{Value, json};

use super::{
    GitLabBoardService, build_gitlab_selected_board_ref, parse_gitlab_issue_key,
    parse_gitlab_selected_board_ref,
};
use crate::gitlab::api_service::GitLabProjectRemote;
use crate::gitlab::config_store::{
    GitLabBoardServiceOptions, GitLabProjectInference, StaticGitLabConfig,
};
use crate::issue_tracker_service::{IssueTrackerService, SilentLogSink};
use crate::test_support::{MockResponse, MockServer, RecordedRequest};

fn no_environment_token() -> Option<String> {
    None
}

fn options() -> GitLabBoardServiceOptions {
    GitLabBoardServiceOptions {
        environment_token: no_environment_token,
        ..GitLabBoardServiceOptions::default()
    }
}

fn config(url: &str) -> StaticGitLabConfig {
    StaticGitLabConfig {
        url: url.to_string(),
        project_path: "group/demo".to_string(),
        api_key: "glpat-test".to_string(),
        ..StaticGitLabConfig::default()
    }
}

fn service_with(
    config: StaticGitLabConfig,
    options: GitLabBoardServiceOptions,
) -> GitLabBoardService {
    GitLabBoardService::with_options(
        Arc::new(config),
        Arc::new(SilentLogSink),
        Client::new(),
        options,
    )
}

fn service(config: StaticGitLabConfig) -> GitLabBoardService {
    service_with(config, options())
}

/// A server that answers nothing useful: the refusal tests assert it saw no request.
async fn unreachable_server() -> MockServer {
    MockServer::start(|_| MockResponse::text(500, "the backend should have refused first")).await
}

fn form(request: &RecordedRequest) -> Vec<(String, String)> {
    reqwest::Url::parse(&format!("http://form.invalid/?{}", request.body))
        .expect("the form body is a query string")
        .query_pairs()
        .into_owned()
        .collect()
}

fn form_value(request: &RecordedRequest, key: &str) -> Option<String> {
    form(request)
        .into_iter()
        .find_map(|(name, value)| (name == key).then_some(value))
}

const ISSUE_JSON: &str = r#"{
    "id": 501, "iid": 7, "title": "New thing", "description": "Details", "state": "opened",
    "labels": [], "assignees": [], "web_url": "https://gitlab.example.com/group/demo/-/issues/7",
    "references": { "full": "group/demo#7" }
}"#;

fn project_json() -> Value {
    json!({ "id": 1, "name": "Demo", "path_with_namespace": "group/demo", "web_url": "https://gitlab.example.com/group/demo" })
}

fn issue_json() -> Value {
    serde_json::from_str(ISSUE_JSON).expect("the issue fixture is JSON")
}

fn create_input(summary: &str, description: Option<&str>) -> CreateIssueInput {
    serde_json::from_value(json!({
        "projectKey": "group/demo",
        "issueType": "issue",
        "summary": summary,
        "description": description
    }))
    .expect("a valid create input")
}

#[tokio::test]
async fn create_issue_refuses_while_the_connection_has_not_enabled_creation() {
    let server = unreachable_server().await;
    let error = service(config(&server.base_url))
        .create_issue(&create_input("x", None))
        .await
        .expect_err("creation is gated");
    assert!(error.contains("Issue creation is disabled for this GitLab connection"));
    assert!(server.requests().is_empty());
}

#[tokio::test]
async fn create_issue_rejects_an_empty_summary() {
    let server = unreachable_server().await;
    let error = service(StaticGitLabConfig {
        allow_issue_creation: true,
        ..config(&server.base_url)
    })
    .create_issue(&create_input("   ", None))
    .await
    .expect_err("empty summary");
    assert_eq!(error, "Summary cannot be empty.");
    assert!(server.requests().is_empty());
}

#[tokio::test]
async fn create_issue_posts_the_title_and_description_then_returns_the_created_issue() {
    let server = MockServer::start(|request| {
        if request.path().ends_with("/notes") {
            MockResponse::text(200, "[]")
        } else if request.method == "POST" || request.path().ends_with("/issues/7") {
            MockResponse::json(&issue_json())
        } else {
            MockResponse::json(&project_json())
        }
    })
    .await;
    let created = service(StaticGitLabConfig {
        allow_issue_creation: true,
        ..config(&server.base_url)
    })
    .create_issue(&create_input("  New thing ", Some(" Details ")))
    .await
    .expect("issue created");

    let requests = server.requests();
    let post = requests
        .iter()
        .find(|request| request.method == "POST")
        .expect("a POST was sent");
    assert_eq!(post.path(), "/api/v4/projects/group%2Fdemo/issues");
    assert_eq!(form_value(post, "title").as_deref(), Some("New thing"));
    assert_eq!(form_value(post, "description").as_deref(), Some("Details"));
    assert_eq!(created.summary.key, "group/demo#7");
    assert_eq!(created.summary.summary, "New thing");
    assert_eq!(created.summary.status, "Open");
}

#[tokio::test]
async fn delete_issue_refuses_by_naming_the_alternative() {
    let server = unreachable_server().await;
    let error = service(config(&server.base_url))
        .delete_issue("group/demo#7")
        .await
        .expect_err("refused");
    assert!(error.ends_with("Close the issue instead."));
    assert!(!error.contains("not implemented yet"));
}

#[tokio::test]
async fn attachments_refuse_by_naming_the_alternative() {
    let server = unreachable_server().await;
    let service = service(config(&server.base_url));
    let attach = service
        .attach_file("group/demo#7", "/tmp/x.png", None)
        .await
        .expect_err("refused");
    assert!(attach.contains("Add files as links"));
    let attachment: IssueAttachment =
        serde_json::from_value(json!({ "fileName": "x.png" })).expect("an attachment");
    let download = service
        .download_attachment("group/demo#7", &attachment, "/tmp/x.png")
        .await
        .expect_err("refused");
    assert!(download.contains("Add files as links"));
    assert!(server.requests().is_empty());
}

#[tokio::test]
async fn board_create_update_and_delete_name_where_to_do_it_instead() {
    let server = unreachable_server().await;
    let service = service(config(&server.base_url));
    let create: CreateBoardInput =
        serde_json::from_value(json!({ "name": "x", "projectKey": "group/demo" }))
            .expect("a create-board input");
    let update: UpdateBoardInput = serde_json::from_value(json!({})).expect("an update input");
    assert!(
        service
            .create_board(&create)
            .await
            .expect_err("refused")
            .contains("Create the board in GitLab")
    );
    assert!(
        service
            .update_board("1", &update)
            .await
            .expect_err("refused")
            .contains("Edit the board in GitLab")
    );
    assert!(
        service
            .delete_board("1")
            .await
            .expect_err("refused")
            .contains("Delete the board in GitLab")
    );
}

#[test]
fn issue_keys_and_selected_board_refs_parse() {
    assert_eq!(
        parse_gitlab_issue_key(" group/sub/demo#12 "),
        Ok(("group/sub/demo".to_string(), 12))
    );
    assert_eq!(
        parse_gitlab_issue_key("demo-12"),
        Err("Invalid GitLab issue key: demo-12".to_string())
    );
    let reference = build_gitlab_selected_board_ref(" group/demo ", 4);
    assert_eq!(reference, "group/demo::4");
    let parsed = parse_gitlab_selected_board_ref(&reference).expect("parses");
    assert_eq!(
        (parsed.project_path.as_str(), parsed.board_id),
        ("group/demo", 4)
    );
    assert_eq!(parse_gitlab_selected_board_ref("::4"), None);
    assert_eq!(parse_gitlab_selected_board_ref("group/demo"), None);
}

fn board_payload() -> Value {
    json!({
        "id": 3, "name": "Dev", "labels": ["team"], "weight": 2,
        "project": { "id": 9, "name": "Demo", "path_with_namespace": "group/demo" },
        "lists": []
    })
}

fn lists_payload() -> Value {
    json!([
        { "id": 21, "position": 1, "assignee": { "id": 44, "username": "ann", "name": "Ann" } },
        { "id": 20, "position": 0, "label": { "name": "Doing" } }
    ])
}

fn board_issue(
    iid: u64,
    state: &str,
    labels: &[&str],
    assignee: Option<&str>,
    updated: &str,
) -> Value {
    json!({
        "id": 500 + iid, "iid": iid, "title": format!("Issue {iid}"), "state": state,
        "labels": labels,
        "assignees": assignee.map(|username| vec![json!({ "username": username })]).unwrap_or_default(),
        "updated_at": updated,
        "references": { "full": format!("group/demo#{iid}") }
    })
}

/// A GitLab project with one board: a `Doing` label list and an `ann` assignee list.
async fn board_server() -> MockServer {
    MockServer::start(|request| {
        let path = request.path();
        if path.ends_with("/boards/3/lists") {
            MockResponse::json(&lists_payload())
        } else if path.ends_with("/boards/3") {
            MockResponse::json(&board_payload())
        } else if path.ends_with("/boards") {
            MockResponse::json(&json!([board_payload()]))
        } else if path.ends_with("/issues") && request.method == "GET" {
            MockResponse::json(&json!([
                board_issue(1, "opened", &["Doing", "bug"], None, "2026-01-03"),
                board_issue(2, "opened", &[], Some("ann"), "2026-01-02"),
                board_issue(3, "opened", &[], None, "2026-01-04"),
                board_issue(4, "closed", &["Doing"], None, "2026-01-01")
            ]))
        } else if path.ends_with("/notes") {
            MockResponse::json(&json!([{ "id": 1, "body": "hi", "author": { "name": "Ann" } }]))
        } else if path.ends_with("/users") {
            MockResponse::json(&json!([{ "id": 44, "username": "ann", "name": "Ann" }]))
        } else if path.ends_with("/user") {
            MockResponse::json(&json!({ "id": 1, "username": " ", "name": "Me" }))
        } else if let Some(iid) = path
            .rsplit("/issues/")
            .next()
            .filter(|_| path.contains("/issues/"))
        {
            let iid: u64 = iid.parse().unwrap_or(1);
            let labels: &[&str] = match iid {
                1 => &["Doing", "bug"],
                4 => &["Doing"],
                _ => &[],
            };
            let state = if iid == 4 { "closed" } else { "opened" };
            let assignee = (iid == 2).then_some("ann");
            MockResponse::json(&board_issue(iid, state, labels, assignee, "2026-01-01"))
        } else {
            MockResponse::json(&project_json())
        }
    })
    .await
}

fn loaded_board() -> Board {
    serde_json::from_value(json!({
        "id": "gitlab:9:3", "name": "Dev", "type": "issue-board", "projectKey": "group/demo"
    }))
    .expect("a board")
}

#[tokio::test]
async fn board_details_place_issues_in_list_backlog_and_closed_columns() {
    let server = board_server().await;
    let service = service(config(&server.base_url));
    let details = service
        .get_board_details(&loaded_board())
        .await
        .expect("board details");
    let names: Vec<&str> = details.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, vec!["Backlog", "Doing", "Ann", "Closed"]);
    let keys = |index: usize| -> Vec<String> {
        details.columns[index]
            .issues
            .iter()
            .map(|issue| issue.key.clone())
            .collect()
    };
    assert_eq!(keys(0), vec!["group/demo#3"]);
    assert_eq!(keys(1), vec!["group/demo#1"]);
    assert_eq!(keys(2), vec!["group/demo#2"]);
    assert_eq!(keys(3), vec!["group/demo#4"]);
    assert_eq!(details.columns[0].id, "3:backlog");
    assert_eq!(details.columns[1].id, "3:list:20");
    assert_eq!(details.board.project_name.as_deref(), Some("Demo"));
    assert_eq!(
        details.board.raw.as_ref().and_then(|raw| raw.get("id")),
        Some(&json!(3))
    );

    let issues_request = server
        .requests()
        .into_iter()
        .find(|request| request.path().ends_with("/issues"))
        .expect("issues listed");
    assert_eq!(
        issues_request.path(),
        "/api/v4/projects/group%2Fdemo/issues"
    );
    assert_eq!(
        issues_request.query_param("labels").as_deref(),
        Some("team")
    );
    assert_eq!(issues_request.query_param("weight").as_deref(), Some("2"));
}

#[tokio::test]
async fn get_issues_filters_sorts_and_pages_the_board_in_memory() {
    let server = board_server().await;
    let service = service(config(&server.base_url));
    let none = service
        .get_issues(&IssueFilters::default(), 0, 10)
        .await
        .expect("no board");
    assert_eq!(none.total, Some(0));
    assert!(server.requests().is_empty());

    let filters = IssueFilters {
        board_id: Some("gitlab:9:3".to_string()),
        ..IssueFilters::default()
    };
    let page = service.get_issues(&filters, 0, 2).await.expect("page");
    assert_eq!(page.total, Some(4));
    assert!(page.has_more);
    let keys: Vec<&str> = page.issues.iter().map(|i| i.key.as_str()).collect();
    assert_eq!(keys, vec!["group/demo#3", "group/demo#1"]);
    assert!(
        server.requests()[0]
            .path()
            .starts_with("/api/v4/projects/9/boards/3")
    );

    let doing = service
        .get_issues(
            &IssueFilters {
                statuses: vec!["Doing".to_string()],
                ..filters.clone()
            },
            0,
            10,
        )
        .await
        .expect("doing");
    assert_eq!(doing.issues.len(), 1);

    let by_parent = service
        .get_issues(
            &IssueFilters {
                parent_key: Some("group/demo#99".to_string()),
                ..filters.clone()
            },
            0,
            10,
        )
        .await
        .expect("parent filter");
    assert!(by_parent.issues.is_empty());

    let metadata = service
        .get_filter_metadata(&filters)
        .await
        .expect("metadata");
    assert_eq!(metadata.statuses, vec!["Ann", "Backlog", "Closed", "Doing"]);
    assert_eq!(metadata.issue_types, vec!["issue"]);
}

#[tokio::test]
async fn transitions_need_a_loaded_board_and_rewrite_labels_and_assignees() {
    let server = board_server().await;
    let service = service(config(&server.base_url));
    assert!(
        service
            .get_transitions("group/demo#1")
            .await
            .expect("no context")
            .is_empty()
    );
    assert_eq!(
        service
            .transition_issue("group/demo#1", "gitlab:Closed")
            .await
            .expect_err("board not loaded"),
        "Load the GitLab board before moving cards so board column transitions are available."
    );

    service
        .get_board_details(&loaded_board())
        .await
        .expect("board loaded");
    let transitions = service
        .get_transitions("group/demo#1")
        .await
        .expect("transitions");
    let ids: Vec<&str> = transitions.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(ids, vec!["gitlab:Backlog", "gitlab:Ann", "gitlab:Closed"]);

    let before = server.requests().len();
    service
        .transition_issue("group/demo#1", "gitlab:Ann")
        .await
        .expect("moved to Ann");
    service
        .transition_issue("group/demo#2", "gitlab:Backlog")
        .await
        .expect("moved to Backlog");
    service
        .transition_issue("group/demo#4", "gitlab:Doing")
        .await
        .expect("reopened into Doing");
    let puts: Vec<RecordedRequest> = server.requests()[before..]
        .iter()
        .filter(|request| request.method == "PUT")
        .cloned()
        .collect();
    assert_eq!(puts.len(), 3);
    assert_eq!(
        form(&puts[0]),
        vec![("assignee_ids".to_string(), "44".to_string())]
    );
    assert_eq!(
        form(&puts[1]),
        vec![("assignee_ids".to_string(), "0".to_string())]
    );
    assert_eq!(
        form(&puts[2]),
        vec![("state_event".to_string(), "reopen".to_string())]
    );

    assert_eq!(
        service
            .transition_issue("group/demo#1", "gitlab:Nope")
            .await
            .expect_err("unknown column"),
        "Unknown GitLab board column: Nope"
    );

    let details = service.get_issue("group/demo#1").await.expect("issue");
    assert_eq!(details.summary.status, "Doing");
    assert_eq!(details.transitions.as_ref().map(Vec::len), Some(3));
    assert_eq!(details.comments.as_ref().map(Vec::len), Some(1));

    service.reset().await.expect("reset");
    let after_reset = service.get_issue("group/demo#1").await.expect("issue");
    assert_eq!(after_reset.summary.status, "Open");
    assert_eq!(after_reset.transitions, Some(Vec::new()));
}

#[tokio::test]
async fn update_issue_resolves_assignees_and_refuses_unsupported_fields() {
    let server = board_server().await;
    let service = service(config(&server.base_url));
    let unsupported = UpdateIssueInput {
        priority: Some("High".to_string()),
        parent_key: Some(None),
        ..UpdateIssueInput::default()
    };
    assert_eq!(
        service
            .update_issue("group/demo#1", &unsupported)
            .await
            .expect_err("unsupported"),
        "GitLab issue editing currently supports summary, description, and assignee only. Unsupported fields: parentKey, priority."
    );
    assert!(server.requests().is_empty());

    service
        .update_issue(
            "group/demo#1",
            &UpdateIssueInput {
                summary: Some("  Renamed ".to_string()),
                assignee: Some(Some("Ann".to_string())),
                ..UpdateIssueInput::default()
            },
        )
        .await
        .expect("updated");
    service
        .update_issue(
            "group/demo#1",
            &UpdateIssueInput {
                assignee: Some(None),
                ..UpdateIssueInput::default()
            },
        )
        .await
        .expect("unassigned");
    let puts: Vec<RecordedRequest> = server
        .requests()
        .into_iter()
        .filter(|request| request.method == "PUT")
        .collect();
    assert_eq!(
        form(&puts[0]),
        vec![
            ("title".to_string(), "Renamed".to_string()),
            ("assignee_ids".to_string(), "44".to_string())
        ]
    );
    assert_eq!(
        form(&puts[1]),
        vec![("assignee_ids".to_string(), "0".to_string())]
    );

    let error = service
        .update_issue(
            "group/demo#1",
            &UpdateIssueInput {
                assignee: Some(Some("nobody".to_string())),
                ..UpdateIssueInput::default()
            },
        )
        .await
        .expect_err("unresolved");
    assert_eq!(
        error,
        "Could not resolve GitLab assignee \"nobody\" to a unique user."
    );
}

#[tokio::test]
async fn boards_list_from_the_configured_project_and_the_connection_checks_out() {
    let server = board_server().await;
    let service = service(config(&server.base_url));
    let boards = service
        .get_boards(&BoardFilters::default())
        .await
        .expect("boards");
    assert_eq!(boards.len(), 1);
    assert_eq!(boards[0].id, "gitlab:9:3");
    assert_eq!(boards[0].project_key.as_deref(), Some("group/demo"));
    let filtered = service
        .get_boards(&BoardFilters {
            search_text: "nothing-matches".to_string(),
            ..BoardFilters::default()
        })
        .await
        .expect("boards");
    assert!(filtered.is_empty());

    let check = service.check_connection().await.expect("check");
    assert_eq!(
        check.message,
        "Connected to GitLab project group/demo. 1 board(s) found."
    );
    assert_eq!(check.server_name.as_deref(), Some(server.base_url.as_str()));
    assert_eq!(
        service.get_self_assignee_label().await.expect("self"),
        Some("Me".to_string())
    );
    assert_eq!(
        server.requests()[0].header("private-token"),
        Some("glpat-test")
    );
}

#[tokio::test]
async fn selected_board_refs_scope_boards_without_a_project_path() {
    let server = board_server().await;
    let service = service(StaticGitLabConfig {
        project_path: String::new(),
        selected_board_refs: vec!["group/demo::3".to_string(), "bad".to_string()],
        ..config(&server.base_url)
    });
    let boards = service
        .get_boards(&BoardFilters::default())
        .await
        .expect("boards");
    assert_eq!(boards.len(), 1);
    assert_eq!(
        server.requests()[0].path(),
        "/api/v4/projects/group%2Fdemo/boards/3"
    );
    let projects = service.get_projects(false).await.expect("projects");
    assert_eq!(projects[0].key, "group/demo");
}

struct FixedInference;

#[async_trait]
impl GitLabProjectInference for FixedInference {
    async fn infer(&self, repo_path: &Path) -> Result<GitLabProjectRemote, String> {
        assert_eq!(repo_path, Path::new("/work/repo"));
        Ok(GitLabProjectRemote {
            base_url: "https://gitlab.example.com".to_string(),
            project_path: "inferred/proj".to_string(),
        })
    }
}

fn environment_token() -> Option<String> {
    Some(" glpat-env ".to_string())
}

#[tokio::test]
async fn without_a_project_path_the_workspace_remote_is_inferred() {
    let server = board_server().await;
    let blank = StaticGitLabConfig {
        project_path: String::new(),
        api_key: String::new(),
        ..config(&server.base_url)
    };
    let error = service_with(
        blank.clone(),
        GitLabBoardServiceOptions {
            environment_token,
            ..options()
        },
    )
    .get_projects(false)
    .await
    .expect_err("no workspace");
    assert_eq!(
        error,
        "Configure a GitLab project path, or open the repository workspace so the project can be inferred."
    );

    let inferring = service_with(
        blank.clone(),
        GitLabBoardServiceOptions {
            workspace_folder_path: Some(Arc::new(|| Some(PathBuf::from("/work/repo")))),
            project_inference: Arc::new(FixedInference),
            environment_token,
            ..options()
        },
    );
    inferring.get_projects(false).await.expect("projects");
    let request = server.requests().pop().expect("a request");
    assert_eq!(request.path(), "/api/v4/projects/inferred%2Fproj");
    assert_eq!(request.header("private-token"), Some("glpat-env"));

    let missing_token = service(blank)
        .get_projects(false)
        .await
        .expect_err("no token");
    assert_eq!(missing_token, "No GitLab API key is configured.");
}
