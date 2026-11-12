//! Opt-in Issue Tracker bridge connecting `crates/praxis-trackers`
//! (`FolderService`, `GitHubBoardService`, `GitLabBoardService`, `StubBackendService`)
//! into desktop service registry and tracker IPC.

use std::sync::Arc;

use praxis_contracts::{
    BackendMode, Board, BoardFilters, CreateIssueInput, IssueFilters, IssueSummary,
    ParentItemQueryOptions, RustRpcError, UpdateIssueInput,
};
use praxis_trackers::{
    FolderService, GitHubBoardService, GitLabBoardService, IssueTrackerService, SilentLogSink,
    StaticFolderConfig, StaticGitHubConfig, StaticGitLabConfig, StubBackendService,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::runtime::Handle;

use crate::HostContext;

fn failure(message: impl std::fmt::Display) -> RustRpcError {
    RustRpcError {
        code: "TRACKER_ERROR".into(),
        message: message.to_string(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackerConnectionInput {
    pub mode: BackendMode,
    #[serde(default)]
    pub folder_config: Option<StaticFolderConfig>,
    #[serde(default)]
    pub github_config: Option<StaticGitHubConfig>,
    #[serde(default)]
    pub gitlab_config: Option<StaticGitLabConfig>,
    #[serde(default)]
    pub jira_config: Option<crate::jira_service::StaticJiraConfig>,
}

fn parse_conn(args: &[Value]) -> Result<TrackerConnectionInput, RustRpcError> {
    let raw = args
        .first()
        .ok_or_else(|| failure("Missing connection configuration argument."))?;
    serde_json::from_value(raw.clone())
        .map_err(|e| failure(format!("Invalid connection configuration: {e}")))
}

#[must_use]
pub fn resolve_tracker_service(input: &TrackerConnectionInput) -> Arc<dyn IssueTrackerService> {
    match input.mode {
        BackendMode::Folder => {
            let cfg = input.folder_config.clone().unwrap_or_default();
            Arc::new(FolderService::from_static(cfg))
        }
        BackendMode::Github => {
            let cfg = input.github_config.clone().unwrap_or_default();
            Arc::new(GitHubBoardService::new(
                Arc::new(cfg),
                Arc::new(SilentLogSink),
            ))
        }
        BackendMode::Gitlab => {
            let cfg = input.gitlab_config.clone().unwrap_or_default();
            Arc::new(GitLabBoardService::new(
                Arc::new(cfg),
                Arc::new(SilentLogSink),
            ))
        }
        BackendMode::Jiracloud => match input.jira_config.clone().filter(|cfg| cfg.is_configured()) {
            Some(cfg) => Arc::new(crate::jira_service::JiraCloudService::new(cfg)),
            None => Arc::new(StubBackendService::new(BackendMode::Jiracloud)),
        },
        other => Arc::new(StubBackendService::new(other)),
    }
}

pub fn register_tracker_channels(host: &HostContext, runtime: &Handle) {
    let rt = runtime.clone();
    host.register_handler("tracker:checkConnection", move |_ctx, args| {
        let conn = parse_conn(args)?;
        let svc = resolve_tracker_service(&conn);
        let res = rt
            .block_on(async { svc.check_connection().await })
            .map_err(failure)?;
        serde_json::to_value(res).map_err(|e| failure(e.to_string()))
    });

    let rt = runtime.clone();
    host.register_handler("tracker:getProjects", move |_ctx, args| {
        let conn = parse_conn(args)?;
        let force_refresh = args.get(1).and_then(Value::as_bool).unwrap_or(false);
        let svc = resolve_tracker_service(&conn);
        let res = rt
            .block_on(async { svc.get_projects(force_refresh).await })
            .map_err(failure)?;
        serde_json::to_value(res).map_err(|e| failure(e.to_string()))
    });

    let rt = runtime.clone();
    host.register_handler("tracker:supportsBoards", move |_ctx, args| {
        let conn = parse_conn(args)?;
        let svc = resolve_tracker_service(&conn);
        let res = rt
            .block_on(async { svc.supports_boards().await })
            .map_err(failure)?;
        Ok(json!(res))
    });

    let rt = runtime.clone();
    host.register_handler("tracker:getBoards", move |_ctx, args| {
        let conn = parse_conn(args)?;
        let filters: BoardFilters = args
            .get(1)
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();
        let svc = resolve_tracker_service(&conn);
        let res = rt
            .block_on(async { svc.get_boards(&filters).await })
            .map_err(failure)?;
        serde_json::to_value(res).map_err(|e| failure(e.to_string()))
    });

    let rt = runtime.clone();
    host.register_handler("tracker:getBoardDetails", move |_ctx, args| {
        let conn = parse_conn(args)?;
        let board: Board = args
            .get(1)
            .ok_or_else(|| failure("Missing board argument."))
            .and_then(|v| {
                serde_json::from_value(v.clone())
                    .map_err(|e| failure(format!("Invalid board argument: {e}")))
            })?;
        let svc = resolve_tracker_service(&conn);
        let res = rt
            .block_on(async { svc.get_board_details(&board).await })
            .map_err(failure)?;
        serde_json::to_value(res).map_err(|e| failure(e.to_string()))
    });

    let rt = runtime.clone();
    host.register_handler("tracker:getIssues", move |_ctx, args| {
        let conn = parse_conn(args)?;
        let filters: IssueFilters = args
            .get(1)
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();
        let start_at = args.get(2).and_then(Value::as_u64).unwrap_or(0) as usize;
        let page_size = args.get(3).and_then(Value::as_u64).unwrap_or(25) as usize;
        let svc = resolve_tracker_service(&conn);
        let res = rt
            .block_on(async { svc.get_issues(&filters, start_at, page_size).await })
            .map_err(failure)?;
        serde_json::to_value(res).map_err(|e| failure(e.to_string()))
    });

    let rt = runtime.clone();
    host.register_handler("tracker:getFilterMetadata", move |_ctx, args| {
        let conn = parse_conn(args)?;
        let filters: IssueFilters = args
            .get(1)
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();
        let svc = resolve_tracker_service(&conn);
        let res = rt
            .block_on(async { svc.get_filter_metadata(&filters).await })
            .map_err(failure)?;
        serde_json::to_value(res).map_err(|e| failure(e.to_string()))
    });

    let rt = runtime.clone();
    host.register_handler("tracker:getParentItems", move |_ctx, args| {
        let conn = parse_conn(args)?;
        let filters: IssueFilters = args
            .get(1)
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();
        let search_text = args.get(2).and_then(Value::as_str);
        let options: Option<ParentItemQueryOptions> = args
            .get(3)
            .and_then(|v| serde_json::from_value(v.clone()).ok());
        let svc = resolve_tracker_service(&conn);
        let res = rt
            .block_on(async {
                svc.get_parent_items(&filters, search_text, options.as_ref())
                    .await
            })
            .map_err(failure)?;
        serde_json::to_value(res).map_err(|e| failure(e.to_string()))
    });

    let rt = runtime.clone();
    host.register_handler("tracker:getIssue", move |_ctx, args| {
        let conn = parse_conn(args)?;
        let issue_key = args
            .get(1)
            .and_then(Value::as_str)
            .ok_or_else(|| failure("Missing issue key argument."))?;
        let svc = resolve_tracker_service(&conn);
        let res = rt
            .block_on(async { svc.get_issue(issue_key).await })
            .map_err(failure)?;
        serde_json::to_value(res).map_err(|e| failure(e.to_string()))
    });

    let rt = runtime.clone();
    host.register_handler("tracker:createIssue", move |_ctx, args| {
        let conn = parse_conn(args)?;
        let input: CreateIssueInput = args
            .get(1)
            .ok_or_else(|| failure("Missing create issue input."))
            .and_then(|v| {
                serde_json::from_value(v.clone())
                    .map_err(|e| failure(format!("Invalid create issue input: {e}")))
            })?;
        let svc = resolve_tracker_service(&conn);
        let res = rt
            .block_on(async { svc.create_issue(&input).await })
            .map_err(failure)?;
        serde_json::to_value(res).map_err(|e| failure(e.to_string()))
    });

    let rt = runtime.clone();
    host.register_handler("tracker:updateIssue", move |_ctx, args| {
        let conn = parse_conn(args)?;
        let issue_key = args
            .get(1)
            .and_then(Value::as_str)
            .ok_or_else(|| failure("Missing issue key argument."))?;
        let input: UpdateIssueInput = args
            .get(2)
            .ok_or_else(|| failure("Missing update issue input."))
            .and_then(|v| {
                serde_json::from_value(v.clone())
                    .map_err(|e| failure(format!("Invalid update issue input: {e}")))
            })?;
        let svc = resolve_tracker_service(&conn);
        let res = rt
            .block_on(async { svc.update_issue(issue_key, &input).await })
            .map_err(failure)?;
        serde_json::to_value(res).map_err(|e| failure(e.to_string()))
    });

    let rt = runtime.clone();
    host.register_handler("tracker:deleteIssue", move |_ctx, args| {
        let conn = parse_conn(args)?;
        let issue_key = args
            .get(1)
            .and_then(Value::as_str)
            .ok_or_else(|| failure("Missing issue key argument."))?;
        let svc = resolve_tracker_service(&conn);
        rt.block_on(async { svc.delete_issue(issue_key).await })
            .map_err(failure)?;
        Ok(Value::Null)
    });

    let rt = runtime.clone();
    host.register_handler("tracker:addComment", move |_ctx, args| {
        let conn = parse_conn(args)?;
        let issue_key = args
            .get(1)
            .and_then(Value::as_str)
            .ok_or_else(|| failure("Missing issue key argument."))?;
        let body = args
            .get(2)
            .and_then(Value::as_str)
            .ok_or_else(|| failure("Missing comment body argument."))?;
        let svc = resolve_tracker_service(&conn);
        rt.block_on(async { svc.add_comment(issue_key, body).await })
            .map_err(failure)?;
        Ok(Value::Null)
    });

    let rt = runtime.clone();
    host.register_handler("tracker:getTransitions", move |_ctx, args| {
        let conn = parse_conn(args)?;
        let issue_key = args
            .get(1)
            .and_then(Value::as_str)
            .ok_or_else(|| failure("Missing issue key argument."))?;
        let svc = resolve_tracker_service(&conn);
        let res = rt
            .block_on(async { svc.get_transitions(issue_key).await })
            .map_err(failure)?;
        serde_json::to_value(res).map_err(|e| failure(e.to_string()))
    });

    let rt = runtime.clone();
    host.register_handler("tracker:transitionIssue", move |_ctx, args| {
        let conn = parse_conn(args)?;
        let issue_key = args
            .get(1)
            .and_then(Value::as_str)
            .ok_or_else(|| failure("Missing issue key argument."))?;
        let transition_id = args
            .get(2)
            .and_then(Value::as_str)
            .ok_or_else(|| failure("Missing transition id argument."))?;
        let svc = resolve_tracker_service(&conn);
        rt.block_on(async { svc.transition_issue(issue_key, transition_id).await })
            .map_err(failure)?;
        Ok(Value::Null)
    });

    let rt = runtime.clone();
    host.register_handler("tracker:getSelfAssigneeLabel", move |_ctx, args| {
        let conn = parse_conn(args)?;
        let svc = resolve_tracker_service(&conn);
        let res = rt
            .block_on(async { svc.get_self_assignee_label().await })
            .map_err(failure)?;
        serde_json::to_value(res).map_err(|e| failure(e.to_string()))
    });

    let rt = runtime.clone();
    host.register_handler("tracker:getBrowseUrl", move |_ctx, args| {
        let conn = parse_conn(args)?;
        let issue: IssueSummary = args
            .get(1)
            .ok_or_else(|| failure("Missing issue summary argument."))
            .and_then(|v| {
                serde_json::from_value(v.clone())
                    .map_err(|e| failure(format!("Invalid issue summary argument: {e}")))
            })?;
        let svc = resolve_tracker_service(&conn);
        let res = rt
            .block_on(async { svc.get_browse_url(&issue).await })
            .map_err(failure)?;
        serde_json::to_value(res).map_err(|e| failure(e.to_string()))
    });

    let rt = runtime.clone();
    host.register_handler("tracker:reset", move |_ctx, args| {
        let conn = parse_conn(args)?;
        let svc = resolve_tracker_service(&conn);
        rt.block_on(async { svc.reset().await }).map_err(failure)?;
        Ok(Value::Null)
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::HostConfig;
    use praxis_contracts::RustRpcRequest;

    fn test_host() -> (HostContext, tokio::runtime::Runtime) {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = format!("/tmp/praxis-tracker-test-{}-{nanos}", std::process::id());
        let settings = format!("{dir}/test-settings.json");
        let config = HostConfig::new(&dir, &settings, true, true).expect("config");
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        let host = HostContext::new(config);
        register_tracker_channels(&host, rt.handle());
        (host, rt)
    }

    fn rpc(host: &HostContext, channel: &str, args: Vec<Value>) -> Value {
        let resp = host.dispatch_rpc(RustRpcRequest {
            id: "test-req".to_string(),
            channel: channel.to_string(),
            args,
        });
        assert!(resp.ok, "RPC {} failed: {:?}", channel, resp.error);
        resp.result.unwrap_or(Value::Null)
    }

    #[test]
    fn test_tracker_stub_backend_channels() {
        let (host, _rt) = test_host();
        let conn = json!({
            "mode": "demo"
        });
        let res = rpc(&host, "tracker:checkConnection", vec![conn.clone()]);
        assert_eq!(res["status"], "error");
        assert!(
            res["message"]
                .as_str()
                .expect("message string")
                .contains("Demo mode is disabled")
        );

        let projects = rpc(&host, "tracker:getProjects", vec![conn.clone()]);
        assert_eq!(projects, json!([]));

        let boards = rpc(&host, "tracker:getBoards", vec![conn]);
        assert_eq!(boards, json!([]));
    }

    #[test]
    fn test_tracker_github_backend_channels() {
        let (host, _rt) = test_host();
        let conn = json!({
            "mode": "github",
            "githubConfig": {
                "owner": "test-owner",
                "repo": "test-repo",
                "apiKey": "test-pat",
                "allowIssueCreation": false
            }
        });
        let res = rpc(&host, "tracker:supportsBoards", vec![conn]);
        assert_eq!(res, json!(true));

        let blank_conn = json!({
            "mode": "github",
            "githubConfig": {
                "owner": "",
                "repo": "test-repo",
                "apiKey": "test-pat"
            }
        });
        let check_resp = host.dispatch_rpc(RustRpcRequest {
            id: "chk-req".to_string(),
            channel: "tracker:checkConnection".to_string(),
            args: vec![blank_conn],
        });
        assert!(!check_resp.ok);
        assert!(
            check_resp
                .error
                .expect("expected error")
                .message
                .contains("owner")
        );
    }

    #[test]
    fn test_tracker_folder_backend_channels() {
        let (host, _rt) = test_host();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = format!(
            "/tmp/praxis-tracker-folder-test-{}-{nanos}",
            std::process::id()
        );
        std::fs::create_dir_all(&dir).expect("create test dir");
        let board_cfg = json!({
            "projectKey": "LIVE",
            "projectName": "Live Plans",
            "allowIssueCreation": true
        });
        std::fs::write(
            format!("{dir}/board.praxis.json"),
            serde_json::to_string(&board_cfg).expect("serialize board config"),
        )
        .expect("write board.praxis.json");

        let conn = json!({
            "mode": "folder",
            "folderConfig": {
                "folderRoots": [dir],
                "projectKey": "LIVE",
                "projectName": "Live Plans",
                "allowIssueCreation": true
            }
        });

        let check = rpc(&host, "tracker:checkConnection", vec![conn.clone()]);
        assert_eq!(check["status"], "ok");

        let projects = rpc(&host, "tracker:getProjects", vec![conn.clone()]);
        assert_eq!(projects[0]["key"], "LIVE");

        let boards = rpc(&host, "tracker:getBoards", vec![conn]);
        assert_eq!(boards.as_array().expect("boards array").len(), 1);
    }
}
