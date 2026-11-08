//! Shell-agnostic service container (`HostContext`) and typed RPC channel dispatcher.

use std::collections::{BTreeMap, HashSet};
use std::path::Path;
use std::sync::{Arc, RwLock};

use praxis_contracts::{
    Board, BoardFilters, CreateIssueInput, IssueFilters, ProjectWorkflowStage, RustRpcError,
    RustRpcRequest, RustRpcResponse, UpdateIssueInput,
};
use praxis_core::config::{
    AppSettings, SharedSettingsStore, merge_app_settings, sanitize_app_settings,
};
use praxis_core::folder::{
    BoardConfigFile, IssueType, discover_plan_folders, discover_repository_folders,
    ensure_front_matter, parse_plan_folder, read_board_config_file, resolve_plan_dependency_keys,
    write_board_config_file,
};
use praxis_core::git::{
    GitBranchInfo, GitCommitInput, GitConflictResolution, GitDiffHunk, GitDiffRequest,
    GitHunkActionRequest, GitService, GitWorktreeManager, PrepareWorktreeOptions,
    RemoveWorktreeOptions, WorktreeIssueInput, WorktreeTarget, build_commit_graph,
    build_partial_hunk_patch, build_worktree_name, delete_run_work_sync,
    ensure_worktrees_excluded_sync, inspect_run_work_sync, parse_git_branches, parse_git_diff,
    parse_git_log, parse_git_status, parse_git_tags, remove_escaping_dependency_links_sync,
};
use praxis_core::projects::{
    ProjectRecord, default_workflow, normalize_workflow_stages, resolve_status,
    validate_workflow_stages, write_project_snapshot,
};
use praxis_core::workspaces::{
    WorkspaceContents, WorkspaceRecord, read_workspace_file, resolve_portable_folder_path,
    to_portable_folder_path, to_workspace_file, workspace_file_name,
};
use praxis_trackers::{FolderService, StaticFolderConfig};
use serde_json::{Value, json};

use crate::config::HostConfig;
use crate::events::HostEventBus;
use crate::host_status;
use crate::secrets::HostSecretStore;

/// Handler function signature for synchronous or runtime-backed RPC channels.
pub type RpcHandlerFn = dyn Fn(&HostContext, &[Value]) -> Result<Value, RustRpcError> + Send + Sync;

/// Shell-agnostic Rust host service container and RPC router.
#[derive(Clone)]
pub struct HostContext {
    config: Arc<HostConfig>,
    events: HostEventBus,
    secrets: HostSecretStore,
    settings: Arc<SharedSettingsStore>,
    git_service: GitService,
    handlers: Arc<RwLock<BTreeMap<String, Arc<RpcHandlerFn>>>>,
}

impl std::fmt::Debug for HostContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostContext")
            .field("config", &self.config)
            .field("registered_channels", &self.registered_channels())
            .finish_non_exhaustive()
    }
}

impl HostContext {
    /// Initializes a new [`HostContext`] with the given isolated [`HostConfig`] and registers
    /// built-in host diagnostic, event, secret-bridge, settings, and workspace channels.
    #[must_use]
    pub fn new(config: HostConfig) -> Self {
        let settings = Arc::new(SharedSettingsStore::new(&config.settings_path));
        let initial_git_exec = settings.read().git.executable_path;
        let git_service = GitService::with_executable(initial_git_exec);
        let ctx = Self {
            config: Arc::new(config),
            events: HostEventBus::default(),
            secrets: HostSecretStore::new(),
            settings,
            git_service,
            handlers: Arc::new(RwLock::new(BTreeMap::new())),
        };
        ctx.register_builtin_handlers();
        ctx
    }

    /// Returns the host's runtime configuration.
    #[must_use]
    pub fn config(&self) -> &HostConfig {
        &self.config
    }

    /// Returns the broadcast event bus for domain notifications.
    #[must_use]
    pub fn events(&self) -> &HostEventBus {
        &self.events
    }

    /// Returns the `safeStorage`-unlocked secret store.
    #[must_use]
    pub fn secrets(&self) -> &HostSecretStore {
        &self.secrets
    }

    /// Returns the shared `settings.json` store.
    #[must_use]
    pub fn settings(&self) -> &SharedSettingsStore {
        &self.settings
    }

    /// Returns the stateful [`GitService`] instance.
    #[must_use]
    pub fn git_service(&self) -> &GitService {
        &self.git_service
    }

    /// Registers or replaces an RPC handler for `channel`.
    pub fn register_handler<F>(&self, channel: impl Into<String>, handler: F)
    where
        F: Fn(&Self, &[Value]) -> Result<Value, RustRpcError> + Send + Sync + 'static,
    {
        if let Ok(mut guard) = self.handlers.write() {
            guard.insert(channel.into(), Arc::new(handler));
        }
    }

    /// Returns `true` if `channel` has a registered Rust RPC handler.
    #[must_use]
    pub fn has_channel(&self, channel: &str) -> bool {
        self.handlers
            .read()
            .is_ok_and(|guard| guard.contains_key(channel))
    }

    /// Returns the sorted list of all channels currently registered in this host container.
    #[must_use]
    pub fn registered_channels(&self) -> Vec<String> {
        self.handlers
            .read()
            .map(|guard| guard.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// Dispatches a typed [`RustRpcRequest`] to the matching channel handler.
    #[must_use]
    pub fn dispatch_rpc(&self, request: RustRpcRequest) -> RustRpcResponse {
        let handler = self
            .handlers
            .read()
            .ok()
            .and_then(|guard| guard.get(&request.channel).cloned());

        let Some(handler) = handler else {
            return RustRpcResponse {
                id: request.id,
                ok: false,
                result: None,
                error: Some(RustRpcError {
                    code: "CHANNEL_NOT_REGISTERED".to_string(),
                    message: format!("Rust host channel '{}' is not registered.", request.channel),
                }),
            };
        };

        match handler(self, &request.args) {
            Ok(result) => RustRpcResponse {
                id: request.id,
                ok: true,
                result: Some(result),
                error: None,
            },
            Err(err) => RustRpcResponse {
                id: request.id,
                ok: false,
                result: None,
                error: Some(err),
            },
        }
    }

    /// Deserializes a JSON [`RustRpcRequest`], dispatches it, and serializes the [`RustRpcResponse`].
    #[must_use]
    pub fn dispatch_rpc_json(&self, raw_request: &str) -> String {
        let response = match serde_json::from_str::<RustRpcRequest>(raw_request) {
            Ok(req) => self.dispatch_rpc(req),
            Err(err) => RustRpcResponse {
                id: String::new(),
                ok: false,
                result: None,
                error: Some(RustRpcError {
                    code: "INVALID_RPC_REQUEST".to_string(),
                    message: format!("Invalid RustRpcRequest JSON: {err}"),
                }),
            },
        };
        serde_json::to_string(&response).unwrap_or_else(|_| {
            r#"{"id":"","ok":false,"error":{"code":"SERIALIZATION_ERROR","message":"Failed to serialize RPC response."}}"#.to_string()
        })
    }

    fn register_builtin_handlers(&self) {
        self.register_handler("host:status", |_ctx, _args| {
            serde_json::to_value(host_status()).map_err(|err| RustRpcError {
                code: "INTERNAL_ERROR".to_string(),
                message: err.to_string(),
            })
        });

        self.register_handler("host:getConfig", |ctx, _args| {
            Ok(json!({
                "userDataDir": ctx.config.user_data_dir.to_string_lossy(),
                "settingsPath": ctx.config.settings_path.to_string_lossy(),
                "demoMode": ctx.config.demo_mode,
                "e2eMode": ctx.config.e2e_mode,
                "registeredChannels": ctx.registered_channels(),
            }))
        });

        self.register_handler("host:ping", |_ctx, args| {
            Ok(json!({
                "pong": true,
                "args": args,
            }))
        });

        self.register_handler("host:emitEvent", |ctx, args| {
            let channel = args
                .first()
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message:
                        "host:emitEvent requires a non-empty channel name as its first argument."
                            .to_string(),
                })?;
            let payload = args.get(1).cloned();
            let envelope = ctx.events.emit(channel, payload);
            serde_json::to_value(envelope).map_err(|err| RustRpcError {
                code: "INTERNAL_ERROR".to_string(),
                message: err.to_string(),
            })
        });

        self.register_handler("host:secrets:get", |ctx, args| {
            let key = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: "host:secrets:get requires a string key.".to_string(),
                })?;
            Ok(match ctx.secrets.get(key) {
                Some(val) => Value::String(val),
                None => Value::Null,
            })
        });

        self.register_handler("host:secrets:has", |ctx, args| {
            let key = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: "host:secrets:has requires a string key.".to_string(),
                })?;
            Ok(Value::Bool(ctx.secrets.has(key)))
        });

        self.register_handler("host:secrets:set", |ctx, args| {
            let key = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: "host:secrets:set requires a string key.".to_string(),
                })?;
            let value = args.get(1).and_then(Value::as_str).unwrap_or_default();
            Ok(Value::Bool(ctx.secrets.set(key, value)))
        });

        self.register_handler("host:secrets:delete", |ctx, args| {
            let key = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: "host:secrets:delete requires a string key.".to_string(),
                })?;
            Ok(Value::Bool(ctx.secrets.delete(key)))
        });

        self.register_handler("host:secrets:listKeys", |ctx, _args| {
            Ok(json!(ctx.secrets.keys()))
        });

        self.register_handler("host:secrets:seed", |ctx, args| {
            let map_val = args.first().cloned().unwrap_or_else(|| json!({}));
            let entries: BTreeMap<String, String> =
                serde_json::from_value(map_val).map_err(|err| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: format!("host:secrets:seed requires a string record: {err}"),
                })?;
            Ok(json!(ctx.secrets.seed(entries)))
        });

        self.register_settings_and_workspace_handlers();
        self.register_projects_and_folder_handlers();
    }

    fn register_settings_and_workspace_handlers(&self) {
        self.register_handler("settings:get", |ctx, _args| {
            serde_json::to_value(ctx.settings.read()).map_err(|err| RustRpcError {
                code: "INTERNAL_ERROR".to_string(),
                message: err.to_string(),
            })
        });

        self.register_handler("settings:set", |ctx, args| {
            let patch = args.first().cloned().unwrap_or_else(|| json!({}));
            let updated = ctx.settings.write(&patch).map_err(|err| RustRpcError {
                code: "SETTINGS_WRITE_ERROR".to_string(),
                message: err.to_string(),
            })?;
            ctx.git_service
                .set_configured_executable(updated.git.executable_path.clone());
            let payload = serde_json::to_value(&updated).map_err(|err| RustRpcError {
                code: "INTERNAL_ERROR".to_string(),
                message: err.to_string(),
            })?;
            ctx.events.emit("settings:changed", Some(payload.clone()));
            Ok(payload)
        });

        self.register_handler("settings:sanitize", |_ctx, args| {
            let raw = args.first().cloned().unwrap_or(Value::Null);
            serde_json::to_value(sanitize_app_settings(&raw)).map_err(|err| RustRpcError {
                code: "INTERNAL_ERROR".to_string(),
                message: err.to_string(),
            })
        });

        self.register_handler("settings:merge", |_ctx, args| {
            let base_val = args.first().cloned().unwrap_or_else(|| json!({}));
            let patch_val = args.get(1).cloned().unwrap_or_else(|| json!({}));
            let base: AppSettings = serde_json::from_value(base_val)
                .unwrap_or_else(|_| sanitize_app_settings(&Value::Null));
            serde_json::to_value(merge_app_settings(&base, &patch_val)).map_err(|err| {
                RustRpcError {
                    code: "INTERNAL_ERROR".to_string(),
                    message: err.to_string(),
                }
            })
        });

        self.register_handler("workspaces:fileName", |_ctx, args| {
            let name = args.first().and_then(Value::as_str).unwrap_or_default();
            Ok(Value::String(workspace_file_name(name)))
        });

        self.register_handler("workspaces:toPortablePath", |_ctx, args| {
            let path = args.first().and_then(Value::as_str).unwrap_or_default();
            let dir = args.get(1).and_then(Value::as_str).unwrap_or_default();
            Ok(Value::String(to_portable_folder_path(path, dir)))
        });

        self.register_handler("workspaces:resolvePortablePath", |_ctx, args| {
            let path = args.first().and_then(Value::as_str).unwrap_or_default();
            let dir = args.get(1).and_then(Value::as_str).unwrap_or_default();
            Ok(Value::String(resolve_portable_folder_path(path, dir)))
        });

        self.register_handler("workspaces:toFile", |_ctx, args| {
            let ws_val = args.first().cloned().ok_or_else(|| RustRpcError {
                code: "INVALID_ARGUMENT".to_string(),
                message: "workspaces:toFile requires a WorkspaceRecord.".to_string(),
            })?;
            let workspace: WorkspaceRecord =
                serde_json::from_value(ws_val).map_err(|err| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: format!("Invalid WorkspaceRecord: {err}"),
                })?;
            let contents: WorkspaceContents = args
                .get(1)
                .cloned()
                .and_then(|v| serde_json::from_value(v).ok())
                .unwrap_or_default();
            let dir = args.get(2).and_then(Value::as_str);
            let doc =
                to_workspace_file(&workspace, &contents, dir).map_err(|msg| RustRpcError {
                    code: "VALIDATION_ERROR".to_string(),
                    message: msg,
                })?;
            serde_json::to_value(doc).map_err(|err| RustRpcError {
                code: "INTERNAL_ERROR".to_string(),
                message: err.to_string(),
            })
        });

        self.register_handler("workspaces:readFile", |_ctx, args| {
            let raw = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: "workspaces:readFile requires raw JSON string.".to_string(),
                })?;
            let dir = args.get(1).and_then(Value::as_str);
            let parsed = read_workspace_file(raw, dir).map_err(|msg| RustRpcError {
                code: "VALIDATION_ERROR".to_string(),
                message: msg,
            })?;
            serde_json::to_value(parsed).map_err(|err| RustRpcError {
                code: "INTERNAL_ERROR".to_string(),
                message: err.to_string(),
            })
        });
    }

    fn parse_folder_paths_arg(arg: Option<&Value>) -> Result<Vec<String>, RustRpcError> {
        let Some(val) = arg else {
            return Err(RustRpcError {
                code: "INVALID_ARGUMENT".to_string(),
                message: "folderService requires a folder path or array of folder paths."
                    .to_string(),
            });
        };
        if let Some(s) = val.as_str() {
            return Ok(vec![s.to_string()]);
        }
        if let Some(arr) = val.as_array() {
            let mut out = Vec::with_capacity(arr.len());
            for item in arr {
                if let Some(s) = item.as_str() {
                    out.push(s.to_string());
                }
            }
            return Ok(out);
        }
        Err(RustRpcError {
            code: "INVALID_ARGUMENT".to_string(),
            message: "folderPaths must be a string or string array.".to_string(),
        })
    }

    fn make_folder_service(folder_paths: Vec<String>, allow_issue_creation: bool) -> FolderService {
        FolderService::from_static(StaticFolderConfig {
            folder_roots: folder_paths,
            allow_issue_creation,
            ..StaticFolderConfig::default()
        })
    }

    fn handle_parse_plan_folder(args: &[Value]) -> Result<Value, RustRpcError> {
        let root = args
            .first()
            .and_then(Value::as_str)
            .ok_or_else(|| RustRpcError {
                code: "INVALID_ARGUMENT".to_string(),
                message: "folder:parsePlanFolder requires a root directory path.".to_string(),
            })?;
        let workflow: Option<Vec<ProjectWorkflowStage>> = args
            .get(1)
            .filter(|v| !v.is_null())
            .cloned()
            .map(serde_json::from_value)
            .transpose()
            .map_err(|err| RustRpcError {
                code: "INVALID_ARGUMENT".to_string(),
                message: format!("Invalid workflow stages: {err}"),
            })?;
        let project_key = args.get(2).and_then(Value::as_str).unwrap_or("LIVE");
        let parsed = parse_plan_folder(root, workflow.as_deref()).map_err(|msg| RustRpcError {
            code: "FOLDER_PARSE_ERROR".to_string(),
            message: msg,
        })?;
        let dep_keys = resolve_plan_dependency_keys(&parsed, project_key);
        Ok(json!({
            "parsed": parsed,
            "dependencyKeys": dep_keys,
        }))
    }

    fn handle_discover_plan_folders(args: &[Value]) -> Result<Value, RustRpcError> {
        let root = args
            .first()
            .and_then(Value::as_str)
            .ok_or_else(|| RustRpcError {
                code: "INVALID_ARGUMENT".to_string(),
                message: "folder:discoverPlanFolders requires a root path.".to_string(),
            })?;
        let folders = discover_plan_folders(root).map_err(|msg| RustRpcError {
            code: "FOLDER_DISCOVER_ERROR".to_string(),
            message: msg,
        })?;
        Ok(json!(folders))
    }

    fn handle_discover_plans(ctx: &HostContext, args: &[Value]) -> Result<Value, RustRpcError> {
        let arg = args
            .first()
            .and_then(Value::as_str)
            .ok_or_else(|| RustRpcError {
                code: "INVALID_ARGUMENT".to_string(),
                message: "folder:discoverPlans requires a connection id or path.".to_string(),
            })?;

        let mut roots: Vec<String> = Vec::new();
        if Path::new(arg).exists() {
            roots.push(arg.to_string());
        } else {
            let raw_settings =
                std::fs::read_to_string(&ctx.config.settings_path).unwrap_or_default();
            let settings_val: Value = serde_json::from_str(&raw_settings).unwrap_or(Value::Null);
            let conn = settings_val
                .get("connections")
                .and_then(Value::as_array)
                .and_then(|conns| {
                    conns
                        .iter()
                        .find(|c| c.get("id").and_then(Value::as_str) == Some(arg))
                })
                .ok_or_else(|| RustRpcError {
                    code: "CONNECTION_NOT_FOUND".to_string(),
                    message: format!("Connection {arg} is not found."),
                })?;

            let mode = conn.get("mode").and_then(Value::as_str).unwrap_or("");
            if mode != "folder" {
                return Err(RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: format!("Connection {arg} is not a folder connection."),
                });
            }

            let conn_settings = conn.get("settings").unwrap_or(&Value::Null);
            if let Some(r_arr) = conn_settings.get("roots").and_then(Value::as_array) {
                for r in r_arr {
                    if let Some(s) = r.as_str() {
                        let trimmed = s.trim();
                        if !trimmed.is_empty() {
                            roots.push(trimmed.to_string());
                        }
                    }
                }
            } else if let Some(path_str) = conn_settings.get("path").and_then(Value::as_str) {
                let trimmed = path_str.trim();
                if !trimmed.is_empty() {
                    roots.push(trimmed.to_string());
                }
            }

            if roots.is_empty() {
                return Err(RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: format!("Folder connection {arg} has no folders configured."),
                });
            }
        }

        let mut seen = HashSet::new();
        let mut discovered = Vec::new();
        for root in roots {
            let folders = discover_plan_folders(&root).map_err(|msg| RustRpcError {
                code: "FOLDER_DISCOVER_ERROR".to_string(),
                message: msg,
            })?;
            for folder in folders {
                let key = folder.plans_root_path.to_lowercase();
                if !seen.contains(&key) {
                    seen.insert(key);
                    discovered.push(folder);
                }
            }
        }

        serde_json::to_value(discovered).map_err(|err| RustRpcError {
            code: "INTERNAL_ERROR".to_string(),
            message: err.to_string(),
        })
    }

    fn handle_read_board_config(args: &[Value]) -> Result<Value, RustRpcError> {
        let root = args
            .first()
            .and_then(Value::as_str)
            .ok_or_else(|| RustRpcError {
                code: "INVALID_ARGUMENT".to_string(),
                message: "folder:readBoardConfig requires a root path.".to_string(),
            })?;
        serde_json::to_value(read_board_config_file(Path::new(root))).map_err(|err| RustRpcError {
            code: "INTERNAL_ERROR".to_string(),
            message: err.to_string(),
        })
    }

    fn handle_write_board_config(args: &[Value]) -> Result<Value, RustRpcError> {
        let root = args
            .first()
            .and_then(Value::as_str)
            .ok_or_else(|| RustRpcError {
                code: "INVALID_ARGUMENT".to_string(),
                message: "folder:writeBoardConfig requires a root path.".to_string(),
            })?;
        let cfg_val = args.get(1).cloned().ok_or_else(|| RustRpcError {
            code: "INVALID_ARGUMENT".to_string(),
            message: "folder:writeBoardConfig requires a BoardConfigFile.".to_string(),
        })?;
        let cfg: BoardConfigFile = serde_json::from_value(cfg_val).map_err(|err| RustRpcError {
            code: "INVALID_ARGUMENT".to_string(),
            message: format!("Invalid BoardConfigFile: {err}"),
        })?;
        write_board_config_file(Path::new(root), &cfg).map_err(|err| RustRpcError {
            code: "IO_ERROR".to_string(),
            message: err.to_string(),
        })?;
        Ok(Value::Bool(true))
    }

    fn handle_ensure_front_matter(args: &[Value]) -> Result<Value, RustRpcError> {
        let content = args.first().and_then(Value::as_str).unwrap_or_default();
        let kind_str = args.get(1).and_then(Value::as_str).unwrap_or("Task");
        let issue_type = IssueType::parse_loose(kind_str).unwrap_or(IssueType::Task);
        Ok(Value::String(ensure_front_matter(content, issue_type)))
    }

    fn register_projects_and_folder_handlers(&self) {
        self.register_handler("projects:defaultWorkflow", |_ctx, _args| {
            serde_json::to_value(default_workflow()).map_err(|err| RustRpcError {
                code: "INTERNAL_ERROR".to_string(),
                message: err.to_string(),
            })
        });

        self.register_handler("projects:resolveStatus", |_ctx, args| {
            let raw = args.first().and_then(Value::as_str).unwrap_or_default();
            let workflow: Option<Vec<ProjectWorkflowStage>> = args
                .get(1)
                .filter(|v| !v.is_null())
                .cloned()
                .map(serde_json::from_value)
                .transpose()
                .map_err(|err| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: format!("Invalid workflow stages: {err}"),
                })?;
            Ok(Value::String(resolve_status(raw, workflow.as_deref())))
        });

        self.register_handler("projects:normalizeWorkflowStages", |_ctx, args| {
            let stages: Option<Vec<ProjectWorkflowStage>> = args
                .first()
                .filter(|v| !v.is_null())
                .cloned()
                .map(serde_json::from_value)
                .transpose()
                .map_err(|err| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: format!("Invalid workflow stages: {err}"),
                })?;
            serde_json::to_value(normalize_workflow_stages(stages.as_deref())).map_err(|err| {
                RustRpcError {
                    code: "INTERNAL_ERROR".to_string(),
                    message: err.to_string(),
                }
            })
        });

        self.register_handler("projects:validateWorkflowStages", |_ctx, args| {
            let stages_val = args
                .first()
                .cloned()
                .unwrap_or_else(|| Value::Array(Vec::new()));
            let stages: Vec<ProjectWorkflowStage> =
                serde_json::from_value(stages_val).map_err(|err| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: format!("Invalid workflow stages: {err}"),
                })?;
            match validate_workflow_stages(&stages) {
                Some(msg) => Ok(Value::String(msg)),
                None => Ok(Value::Null),
            }
        });

        self.register_handler("projects:writeSnapshot", |_ctx, args| {
            let folder = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: "projects:writeSnapshot requires a folder path.".to_string(),
                })?;
            let project_val = args.get(1).cloned().ok_or_else(|| RustRpcError {
                code: "INVALID_ARGUMENT".to_string(),
                message: "projects:writeSnapshot requires a ProjectRecord.".to_string(),
            })?;
            let project: ProjectRecord =
                serde_json::from_value(project_val).map_err(|err| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: format!("Invalid ProjectRecord: {err}"),
                })?;
            let status = write_project_snapshot(Path::new(folder), &project).map_err(|err| {
                RustRpcError {
                    code: "IO_ERROR".to_string(),
                    message: err.to_string(),
                }
            })?;
            serde_json::to_value(status).map_err(|err| RustRpcError {
                code: "INTERNAL_ERROR".to_string(),
                message: err.to_string(),
            })
        });

        self.register_handler("folder:parsePlanFolder", |_ctx, args| {
            Self::handle_parse_plan_folder(args)
        });
        self.register_handler("plans:parsePlanFolder", |_ctx, args| {
            Self::handle_parse_plan_folder(args)
        });

        self.register_handler("folder:discoverPlanFolders", |_ctx, args| {
            Self::handle_discover_plan_folders(args)
        });
        self.register_handler("plans:discoverPlanFolders", |_ctx, args| {
            Self::handle_discover_plan_folders(args)
        });

        self.register_handler("folder:discoverPlans", |ctx, args| {
            Self::handle_discover_plans(ctx, args)
        });
        self.register_handler("plans:discoverPlans", |ctx, args| {
            Self::handle_discover_plans(ctx, args)
        });

        self.register_handler("folder:discoverRepositoryFolders", |_ctx, args| {
            let root = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: "folder:discoverRepositoryFolders requires a root path.".to_string(),
                })?;
            let repos = discover_repository_folders(root).map_err(|msg| RustRpcError {
                code: "FOLDER_DISCOVER_ERROR".to_string(),
                message: msg,
            })?;
            Ok(json!(repos))
        });

        self.register_handler("folder:readBoardConfig", |_ctx, args| {
            Self::handle_read_board_config(args)
        });
        self.register_handler("plans:readBoardConfig", |_ctx, args| {
            Self::handle_read_board_config(args)
        });

        self.register_handler("folder:writeBoardConfig", |_ctx, args| {
            Self::handle_write_board_config(args)
        });
        self.register_handler("plans:writeBoardConfig", |_ctx, args| {
            Self::handle_write_board_config(args)
        });

        self.register_handler("folder:ensureFrontMatter", |_ctx, args| {
            Self::handle_ensure_front_matter(args)
        });
        self.register_handler("plans:ensureFrontMatter", |_ctx, args| {
            Self::handle_ensure_front_matter(args)
        });

        self.register_handler("folderService:getBoards", |_ctx, args| {
            let paths = Self::parse_folder_paths_arg(args.first())?;
            let svc = Self::make_folder_service(paths, false);
            let boards = svc
                .get_boards(&BoardFilters::default())
                .map_err(|msg| RustRpcError {
                    code: "FOLDER_SERVICE_ERROR".to_string(),
                    message: msg,
                })?;
            serde_json::to_value(boards).map_err(|err| RustRpcError {
                code: "INTERNAL_ERROR".to_string(),
                message: err.to_string(),
            })
        });

        self.register_handler("folderService:getBoardDetails", |_ctx, args| {
            let paths = Self::parse_folder_paths_arg(args.first())?;
            let board_val = args.get(1).cloned().ok_or_else(|| RustRpcError {
                code: "INVALID_ARGUMENT".to_string(),
                message: "folderService:getBoardDetails requires a Board.".to_string(),
            })?;
            let board: Board = serde_json::from_value(board_val).map_err(|err| RustRpcError {
                code: "INVALID_ARGUMENT".to_string(),
                message: format!("Invalid Board: {err}"),
            })?;
            let svc = Self::make_folder_service(paths, false);
            let details = svc.get_board_details(&board).map_err(|msg| RustRpcError {
                code: "FOLDER_SERVICE_ERROR".to_string(),
                message: msg,
            })?;
            serde_json::to_value(details).map_err(|err| RustRpcError {
                code: "INTERNAL_ERROR".to_string(),
                message: err.to_string(),
            })
        });

        self.register_handler("folderService:getIssues", |_ctx, args| {
            let paths = Self::parse_folder_paths_arg(args.first())?;
            let filters: IssueFilters = args
                .get(1)
                .filter(|v| !v.is_null())
                .cloned()
                .map(serde_json::from_value)
                .transpose()
                .map_err(|err| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: format!("Invalid IssueFilters: {err}"),
                })?
                .unwrap_or_default();
            let start_at = args
                .get(2)
                .and_then(Value::as_u64)
                .and_then(|v| usize::try_from(v).ok())
                .unwrap_or(0);
            let page_size = args
                .get(3)
                .and_then(Value::as_u64)
                .and_then(|v| usize::try_from(v).ok())
                .unwrap_or(200);
            let svc = Self::make_folder_service(paths, false);
            let paged = svc
                .get_issues(&filters, start_at, page_size)
                .map_err(|msg| RustRpcError {
                    code: "FOLDER_SERVICE_ERROR".to_string(),
                    message: msg,
                })?;
            serde_json::to_value(paged).map_err(|err| RustRpcError {
                code: "INTERNAL_ERROR".to_string(),
                message: err.to_string(),
            })
        });

        self.register_handler("folderService:getIssue", |_ctx, args| {
            let paths = Self::parse_folder_paths_arg(args.first())?;
            let issue_key = args
                .get(1)
                .and_then(Value::as_str)
                .ok_or_else(|| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: "folderService:getIssue requires an issueKey.".to_string(),
                })?;
            let svc = Self::make_folder_service(paths, false);
            let details = svc.get_issue(issue_key).map_err(|msg| RustRpcError {
                code: "NOT_FOUND".to_string(),
                message: msg,
            })?;
            serde_json::to_value(details).map_err(|err| RustRpcError {
                code: "INTERNAL_ERROR".to_string(),
                message: err.to_string(),
            })
        });

        self.register_handler("folderService:getTransitions", |_ctx, args| {
            let paths = Self::parse_folder_paths_arg(args.first())?;
            let issue_key = args
                .get(1)
                .and_then(Value::as_str)
                .ok_or_else(|| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: "folderService:getTransitions requires an issueKey.".to_string(),
                })?;
            let svc = Self::make_folder_service(paths, false);
            let transitions = svc.get_transitions(issue_key).map_err(|msg| RustRpcError {
                code: "FOLDER_SERVICE_ERROR".to_string(),
                message: msg,
            })?;
            serde_json::to_value(transitions).map_err(|err| RustRpcError {
                code: "INTERNAL_ERROR".to_string(),
                message: err.to_string(),
            })
        });

        self.register_handler("folderService:createIssue", |_ctx, args| {
            let paths = Self::parse_folder_paths_arg(args.first())?;
            let input_val = args.get(1).cloned().ok_or_else(|| RustRpcError {
                code: "INVALID_ARGUMENT".to_string(),
                message: "folderService:createIssue requires CreateIssueInput.".to_string(),
            })?;
            let input: CreateIssueInput =
                serde_json::from_value(input_val).map_err(|err| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: format!("Invalid CreateIssueInput: {err}"),
                })?;
            let allow_creation = args.get(2).and_then(Value::as_bool).unwrap_or(true);
            let svc = Self::make_folder_service(paths, allow_creation);
            let created = svc.create_issue(&input).map_err(|msg| RustRpcError {
                code: "FOLDER_SERVICE_ERROR".to_string(),
                message: msg,
            })?;
            serde_json::to_value(created).map_err(|err| RustRpcError {
                code: "INTERNAL_ERROR".to_string(),
                message: err.to_string(),
            })
        });

        self.register_handler("folderService:updateIssue", |_ctx, args| {
            let paths = Self::parse_folder_paths_arg(args.first())?;
            let issue_key = args
                .get(1)
                .and_then(Value::as_str)
                .ok_or_else(|| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: "folderService:updateIssue requires an issueKey.".to_string(),
                })?;
            let input_val = args.get(2).cloned().ok_or_else(|| RustRpcError {
                code: "INVALID_ARGUMENT".to_string(),
                message: "folderService:updateIssue requires UpdateIssueInput.".to_string(),
            })?;
            let input: UpdateIssueInput =
                serde_json::from_value(input_val).map_err(|err| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: format!("Invalid UpdateIssueInput: {err}"),
                })?;
            let svc = Self::make_folder_service(paths, false);
            let updated = svc
                .update_issue(issue_key, &input)
                .map_err(|msg| RustRpcError {
                    code: "FOLDER_SERVICE_ERROR".to_string(),
                    message: msg,
                })?;
            serde_json::to_value(updated).map_err(|err| RustRpcError {
                code: "INTERNAL_ERROR".to_string(),
                message: err.to_string(),
            })
        });

        self.register_handler("folderService:transitionIssue", |_ctx, args| {
            let paths = Self::parse_folder_paths_arg(args.first())?;
            let issue_key = args
                .get(1)
                .and_then(Value::as_str)
                .ok_or_else(|| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: "folderService:transitionIssue requires an issueKey.".to_string(),
                })?;
            let transition_id =
                args.get(2)
                    .and_then(Value::as_str)
                    .ok_or_else(|| RustRpcError {
                        code: "INVALID_ARGUMENT".to_string(),
                        message: "folderService:transitionIssue requires a transitionId."
                            .to_string(),
                    })?;
            let svc = Self::make_folder_service(paths, false);
            svc.transition_issue(issue_key, transition_id)
                .map_err(|msg| RustRpcError {
                    code: "FOLDER_SERVICE_ERROR".to_string(),
                    message: msg,
                })?;
            Ok(Value::Bool(true))
        });

        self.register_handler("folderService:addComment", |_ctx, args| {
            let paths = Self::parse_folder_paths_arg(args.first())?;
            let issue_key = args
                .get(1)
                .and_then(Value::as_str)
                .ok_or_else(|| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: "folderService:addComment requires an issueKey.".to_string(),
                })?;
            let body = args
                .get(2)
                .and_then(Value::as_str)
                .ok_or_else(|| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: "folderService:addComment requires a comment body.".to_string(),
                })?;
            let svc = Self::make_folder_service(paths, false);
            svc.add_comment(issue_key, body)
                .map_err(|msg| RustRpcError {
                    code: "FOLDER_SERVICE_ERROR".to_string(),
                    message: msg,
                })?;
            Ok(Value::Bool(true))
        });

        self.register_git_handlers();
    }

    fn parse_string_vec_arg(arg: Option<&Value>, label: &str) -> Result<Vec<String>, RustRpcError> {
        let arr = arg.and_then(Value::as_array).ok_or_else(|| RustRpcError {
            code: "INVALID_ARGUMENT".to_string(),
            message: format!("{label} requires a string array."),
        })?;
        Ok(arr
            .iter()
            .filter_map(Value::as_str)
            .map(ToString::to_string)
            .collect())
    }

    fn git_err(message: String) -> RustRpcError {
        RustRpcError {
            code: "GIT_ERROR".to_string(),
            message,
        }
    }

    fn to_json_val<T: serde::Serialize>(val: T) -> Result<Value, RustRpcError> {
        serde_json::to_value(val).map_err(|err| RustRpcError {
            code: "INTERNAL_ERROR".to_string(),
            message: err.to_string(),
        })
    }

    fn register_git_handlers(&self) {
        self.register_handler("git:preflight", |ctx, args| {
            let repo_path = args.first().and_then(Value::as_str);
            let svc = ctx.git_service();
            let res = svc.block_on(svc.preflight_git_repository(repo_path));
            Self::to_json_val(res)
        });

        self.register_handler("git:initialize", |ctx, args| {
            let repo_path = args.first().and_then(Value::as_str).unwrap_or("");
            let svc = ctx.git_service();
            let res = svc
                .block_on(svc.initialize_git_repository(repo_path))
                .map_err(Self::git_err)?;
            Self::to_json_val(res)
        });

        self.register_handler("git:clone", |ctx, args| {
            let repo_url = args.first().and_then(Value::as_str).unwrap_or("");
            let target_parent = args.get(1).and_then(Value::as_str).unwrap_or("");
            let target_name = args.get(2).and_then(Value::as_str);
            let svc = ctx.git_service();
            let res = svc
                .block_on(svc.clone_git_repository(repo_url, target_parent, target_name))
                .map_err(Self::git_err)?;
            Self::to_json_val(res)
        });

        self.register_handler("git:open", |ctx, args| {
            let repo_path = args.first().and_then(Value::as_str).unwrap_or("");
            let svc = ctx.git_service();
            let res = svc
                .block_on(svc.load_git_repository(repo_path, false))
                .map_err(Self::git_err)?;
            Self::to_json_val(res)
        });

        self.register_handler("git:refresh", |ctx, args| {
            let repo_path = args.first().and_then(Value::as_str).unwrap_or("");
            let svc = ctx.git_service();
            let res = svc
                .block_on(svc.load_git_repository(repo_path, true))
                .map_err(Self::git_err)?;
            Self::to_json_val(res)
        });

        self.register_handler("git:status", |ctx, args| {
            let repo_path = args.first().and_then(Value::as_str).unwrap_or("");
            let svc = ctx.git_service();
            let res = svc
                .block_on(svc.get_git_status(repo_path))
                .map_err(Self::git_err)?;
            Self::to_json_val(res)
        });

        self.register_handler("git:getCommit", |ctx, args| {
            let repo_path = args.first().and_then(Value::as_str).unwrap_or("");
            let hash = args.get(1).and_then(Value::as_str).unwrap_or("");
            let svc = ctx.git_service();
            let res = svc
                .block_on(svc.get_git_commit(repo_path, hash))
                .map_err(Self::git_err)?;
            Self::to_json_val(res)
        });

        self.register_handler("git:getDiff", |ctx, args| {
            let repo_path = args.first().and_then(Value::as_str).unwrap_or("");
            let hash = args.get(1).and_then(Value::as_str).unwrap_or("");
            let file_path = args.get(2).and_then(Value::as_str);
            let svc = ctx.git_service();
            let res = svc
                .block_on(svc.get_git_diff(repo_path, hash, file_path))
                .map_err(Self::git_err)?;
            Self::to_json_val(res)
        });

        self.register_handler("git:getComparison", |ctx, args| {
            let repo_path = args.first().and_then(Value::as_str).unwrap_or("");
            let req_val = args.get(1).cloned().ok_or_else(|| RustRpcError {
                code: "INVALID_ARGUMENT".to_string(),
                message: "git:getComparison requires a GitDiffRequest.".to_string(),
            })?;
            let request: GitDiffRequest =
                serde_json::from_value(req_val).map_err(|err| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: format!("Invalid GitDiffRequest: {err}"),
                })?;
            let svc = ctx.git_service();
            let res = svc
                .block_on(svc.get_git_comparison(repo_path, request))
                .map_err(Self::git_err)?;
            Self::to_json_val(res)
        });

        self.register_handler("git:applyHunk", |ctx, args| {
            let repo_path = args.first().and_then(Value::as_str).unwrap_or("");
            let req_val = args.get(1).cloned().ok_or_else(|| RustRpcError {
                code: "INVALID_ARGUMENT".to_string(),
                message: "git:applyHunk requires a GitHunkActionRequest.".to_string(),
            })?;
            let request: GitHunkActionRequest =
                serde_json::from_value(req_val).map_err(|err| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: format!("Invalid GitHunkActionRequest: {err}"),
                })?;
            let svc = ctx.git_service();
            let res = svc
                .block_on(svc.apply_git_hunk(repo_path, &request))
                .map_err(Self::git_err)?;
            Self::to_json_val(res)
        });

        self.register_handler("git:stage", |ctx, args| {
            let repo_path = args.first().and_then(Value::as_str).unwrap_or("");
            let paths = Self::parse_string_vec_arg(args.get(1), "git:stage")?;
            let svc = ctx.git_service();
            let res = svc
                .block_on(svc.stage_git(repo_path, &paths))
                .map_err(Self::git_err)?;
            Self::to_json_val(res)
        });

        self.register_handler("git:unstage", |ctx, args| {
            let repo_path = args.first().and_then(Value::as_str).unwrap_or("");
            let paths = Self::parse_string_vec_arg(args.get(1), "git:unstage")?;
            let svc = ctx.git_service();
            let res = svc
                .block_on(svc.unstage_git(repo_path, &paths))
                .map_err(Self::git_err)?;
            Self::to_json_val(res)
        });

        self.register_handler("git:discard", |ctx, args| {
            let repo_path = args.first().and_then(Value::as_str).unwrap_or("");
            let paths = Self::parse_string_vec_arg(args.get(1), "git:discard")?;
            let svc = ctx.git_service();
            let res = svc
                .block_on(svc.discard_git(repo_path, &paths))
                .map_err(Self::git_err)?;
            Self::to_json_val(res)
        });

        self.register_handler("git:commit", |ctx, args| {
            let repo_path = args.first().and_then(Value::as_str).unwrap_or("");
            let message = args.get(1).and_then(Value::as_str).unwrap_or("");
            let svc = ctx.git_service();
            let res = svc
                .block_on(svc.commit_git(repo_path, message))
                .map_err(Self::git_err)?;
            Self::to_json_val(res)
        });

        self.register_handler("git:createBranch", |ctx, args| {
            let repo_path = args.first().and_then(Value::as_str).unwrap_or("");
            let name = args.get(1).and_then(Value::as_str).unwrap_or("");
            let start_point = args.get(2).and_then(Value::as_str);
            let svc = ctx.git_service();
            let res = svc
                .block_on(svc.create_branch_git(repo_path, name, start_point))
                .map_err(Self::git_err)?;
            Self::to_json_val(res)
        });

        self.register_handler("git:checkout", |ctx, args| {
            let repo_path = args.first().and_then(Value::as_str).unwrap_or("");
            let name = args.get(1).and_then(Value::as_str).unwrap_or("");
            let svc = ctx.git_service();
            let res = svc
                .block_on(svc.checkout_git(repo_path, name))
                .map_err(Self::git_err)?;
            Self::to_json_val(res)
        });

        self.register_handler("git:deleteBranch", |ctx, args| {
            let repo_path = args.first().and_then(Value::as_str).unwrap_or("");
            let name = args.get(1).and_then(Value::as_str).unwrap_or("");
            let svc = ctx.git_service();
            let res = svc
                .block_on(svc.delete_branch_git(repo_path, name))
                .map_err(Self::git_err)?;
            Self::to_json_val(res)
        });

        self.register_handler("git:renameBranch", |ctx, args| {
            let repo_path = args.first().and_then(Value::as_str).unwrap_or("");
            let old_name = args.get(1).and_then(Value::as_str).unwrap_or("");
            let new_name = args.get(2).and_then(Value::as_str).unwrap_or("");
            let svc = ctx.git_service();
            let res = svc
                .block_on(svc.rename_branch_git(repo_path, old_name, new_name))
                .map_err(Self::git_err)?;
            Self::to_json_val(res)
        });

        self.register_handler("git:merge", |ctx, args| {
            let repo_path = args.first().and_then(Value::as_str).unwrap_or("");
            let source = args.get(1).and_then(Value::as_str).unwrap_or("");
            let svc = ctx.git_service();
            let res = svc
                .block_on(svc.merge_git(repo_path, source))
                .map_err(Self::git_err)?;
            Self::to_json_val(res)
        });

        self.register_handler("git:rebase", |ctx, args| {
            let repo_path = args.first().and_then(Value::as_str).unwrap_or("");
            let target = args.get(1).and_then(Value::as_str).unwrap_or("");
            let svc = ctx.git_service();
            let res = svc
                .block_on(svc.rebase_git(repo_path, target))
                .map_err(Self::git_err)?;
            Self::to_json_val(res)
        });

        self.register_handler("git:getConflict", |ctx, args| {
            let repo_path = args.first().and_then(Value::as_str).unwrap_or("");
            let file_path = args.get(1).and_then(Value::as_str).unwrap_or("");
            let svc = ctx.git_service();
            let res = svc
                .block_on(svc.get_git_conflict(repo_path, file_path))
                .map_err(Self::git_err)?;
            Self::to_json_val(res)
        });

        self.register_handler("git:resolveConflict", |ctx, args| {
            let repo_path = args.first().and_then(Value::as_str).unwrap_or("");
            let file_path = args.get(1).and_then(Value::as_str).unwrap_or("");
            let res_val = args.get(2).cloned().ok_or_else(|| RustRpcError {
                code: "INVALID_ARGUMENT".to_string(),
                message: "git:resolveConflict requires a GitConflictResolution.".to_string(),
            })?;
            let resolution: GitConflictResolution =
                serde_json::from_value(res_val).map_err(|err| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: format!("Invalid GitConflictResolution: {err}"),
                })?;
            let svc = ctx.git_service();
            let res = svc
                .block_on(svc.resolve_git_conflict(repo_path, file_path, &resolution))
                .map_err(Self::git_err)?;
            Self::to_json_val(res)
        });

        self.register_handler("git:abortConflict", |ctx, args| {
            let repo_path = args.first().and_then(Value::as_str).unwrap_or("");
            let svc = ctx.git_service();
            let res = svc
                .block_on(svc.abort_git_conflict(repo_path))
                .map_err(Self::git_err)?;
            Self::to_json_val(res)
        });

        self.register_handler("git:getFileContent", |ctx, args| {
            let repo_path = args.first().and_then(Value::as_str).unwrap_or("");
            let file_path = args.get(1).and_then(Value::as_str).unwrap_or("");
            let svc = ctx.git_service();
            let res = svc
                .block_on(svc.get_git_file_content(repo_path, file_path))
                .map_err(Self::git_err)?;
            Self::to_json_val(res)
        });

        self.register_handler("git:getFileHistory", |ctx, args| {
            let repo_path = args.first().and_then(Value::as_str).unwrap_or("");
            let file_path = args.get(1).and_then(Value::as_str).unwrap_or("");
            let ref_name = args.get(2).and_then(Value::as_str);
            let svc = ctx.git_service();
            let res = svc
                .block_on(svc.get_git_file_history(repo_path, file_path, ref_name))
                .map_err(Self::git_err)?;
            Self::to_json_val(res)
        });

        self.register_handler("git:getBlame", |ctx, args| {
            let repo_path = args.first().and_then(Value::as_str).unwrap_or("");
            let file_path = args.get(1).and_then(Value::as_str).unwrap_or("");
            let ref_name = args.get(2).and_then(Value::as_str);
            let svc = ctx.git_service();
            let res = svc
                .block_on(svc.get_git_blame(repo_path, file_path, ref_name))
                .map_err(Self::git_err)?;
            Self::to_json_val(res)
        });

        self.register_handler("git:cherryPick", |ctx, args| {
            let repo_path = args.first().and_then(Value::as_str).unwrap_or("");
            let commitish = args.get(1).and_then(Value::as_str).unwrap_or("");
            let svc = ctx.git_service();
            let res = svc
                .block_on(svc.cherry_pick_git(repo_path, commitish))
                .map_err(Self::git_err)?;
            Self::to_json_val(res)
        });

        self.register_handler("git:revert", |ctx, args| {
            let repo_path = args.first().and_then(Value::as_str).unwrap_or("");
            let commitish = args.get(1).and_then(Value::as_str).unwrap_or("");
            let svc = ctx.git_service();
            let res = svc
                .block_on(svc.revert_git(repo_path, commitish))
                .map_err(Self::git_err)?;
            Self::to_json_val(res)
        });

        self.register_handler("git:stash", |ctx, args| {
            let repo_path = args.first().and_then(Value::as_str).unwrap_or("");
            let message = args.get(1).and_then(Value::as_str);
            let svc = ctx.git_service();
            let res = svc
                .block_on(svc.stash_git(repo_path, message))
                .map_err(Self::git_err)?;
            Self::to_json_val(res)
        });

        self.register_handler("git:popStash", |ctx, args| {
            let repo_path = args.first().and_then(Value::as_str).unwrap_or("");
            let svc = ctx.git_service();
            let res = svc
                .block_on(svc.pop_git_stash(repo_path))
                .map_err(Self::git_err)?;
            Self::to_json_val(res)
        });

        self.register_handler("git:pull", |ctx, args| {
            let repo_path = args.first().and_then(Value::as_str).unwrap_or("");
            let svc = ctx.git_service();
            let res = svc
                .block_on(svc.pull_git(repo_path))
                .map_err(Self::git_err)?;
            Self::to_json_val(res)
        });

        self.register_handler("git:fetch", |ctx, args| {
            let repo_path = args.first().and_then(Value::as_str).unwrap_or("");
            let svc = ctx.git_service();
            let res = svc
                .block_on(svc.fetch_git(repo_path))
                .map_err(Self::git_err)?;
            Self::to_json_val(res)
        });

        self.register_handler("git:push", |ctx, args| {
            let repo_path = args.first().and_then(Value::as_str).unwrap_or("");
            let svc = ctx.git_service();
            let res = svc
                .block_on(svc.push_git(repo_path))
                .map_err(Self::git_err)?;
            Self::to_json_val(res)
        });

        self.register_handler("git:parseBranches", |_ctx, args| {
            let raw = args.first().and_then(Value::as_str).unwrap_or("");
            Self::to_json_val(parse_git_branches(raw))
        });

        self.register_handler("git:parseTags", |_ctx, args| {
            let raw = args.first().and_then(Value::as_str).unwrap_or("");
            Self::to_json_val(parse_git_tags(raw))
        });

        self.register_handler("git:parseLog", |_ctx, args| {
            let raw = args.first().and_then(Value::as_str).unwrap_or("");
            Self::to_json_val(parse_git_log(raw))
        });

        self.register_handler("git:parseStatus", |_ctx, args| {
            let raw = args.first().and_then(Value::as_str).unwrap_or("");
            let repo_path = args.get(1).and_then(Value::as_str).unwrap_or("");
            let branch = args.get(2).and_then(Value::as_str).map(ToString::to_string);
            Self::to_json_val(parse_git_status(raw, repo_path, branch))
        });

        self.register_handler("git:parseDiff", |_ctx, args| {
            let raw = args.first().and_then(Value::as_str).unwrap_or("");
            Self::to_json_val(parse_git_diff(raw))
        });

        self.register_handler("git:buildPartialHunkPatch", |_ctx, args| {
            let hunk_val = args.first().cloned().ok_or_else(|| RustRpcError {
                code: "INVALID_ARGUMENT".to_string(),
                message: "git:buildPartialHunkPatch requires a GitDiffHunk.".to_string(),
            })?;
            let hunk: GitDiffHunk =
                serde_json::from_value(hunk_val).map_err(|err| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: format!("Invalid GitDiffHunk: {err}"),
                })?;
            let selected: Vec<usize> = args
                .get(1)
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_u64().map(|n| n as usize))
                        .collect()
                })
                .unwrap_or_default();
            Ok(Value::String(build_partial_hunk_patch(&hunk, &selected)))
        });

        self.register_handler("git:buildCommitGraph", |_ctx, args| {
            let commits_val = args.first().cloned().unwrap_or_else(|| json!([]));
            let commits: Vec<GitCommitInput> =
                serde_json::from_value(commits_val).map_err(|err| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: format!("Invalid commits array: {err}"),
                })?;
            let refs_val = args.get(1).cloned().unwrap_or_else(|| json!({}));
            let refs: std::collections::HashMap<String, Vec<String>> =
                serde_json::from_value(refs_val).map_err(|err| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: format!("Invalid refs map: {err}"),
                })?;
            let branches_val = args.get(2).cloned().unwrap_or_else(|| json!([]));
            let branches: Vec<GitBranchInfo> =
                serde_json::from_value(branches_val).map_err(|err| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: format!("Invalid branches array: {err}"),
                })?;
            Self::to_json_val(build_commit_graph(&commits, &refs, &branches))
        });

        self.register_handler("worktree:buildName", |_ctx, args| {
            let issue_val = args.first().cloned().ok_or_else(|| RustRpcError {
                code: "INVALID_ARGUMENT".to_string(),
                message: "worktree:buildName requires a WorktreeIssueInput.".to_string(),
            })?;
            let issue: WorktreeIssueInput =
                serde_json::from_value(issue_val).map_err(|err| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: format!("Invalid WorktreeIssueInput: {err}"),
                })?;
            Ok(Value::String(build_worktree_name(&issue)))
        });

        self.register_handler("worktree:prepare", |_ctx, args| {
            let issue_val = args.first().cloned().ok_or_else(|| RustRpcError {
                code: "INVALID_ARGUMENT".to_string(),
                message: "worktree:prepare requires a WorktreeIssueInput.".to_string(),
            })?;
            let issue: WorktreeIssueInput =
                serde_json::from_value(issue_val).map_err(|err| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: format!("Invalid WorktreeIssueInput: {err}"),
                })?;
            let base_branch = args.get(1).and_then(Value::as_str).unwrap_or("main");
            let workspace_path = args.get(2).and_then(Value::as_str).unwrap_or("");
            let opts: Option<PrepareWorktreeOptions> = args
                .get(3)
                .filter(|v| !v.is_null())
                .cloned()
                .map(serde_json::from_value)
                .transpose()
                .map_err(|err| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: format!("Invalid PrepareWorktreeOptions: {err}"),
                })?;
            let mgr = GitWorktreeManager::silent();
            let prepared = mgr
                .prepare_delivery_worktree_sync(
                    &issue,
                    base_branch,
                    Path::new(workspace_path),
                    opts.as_ref(),
                )
                .map_err(|err| RustRpcError {
                    code: if err.is_conflict() {
                        "WORKTREE_CONFLICT".to_string()
                    } else {
                        "WORKTREE_ERROR".to_string()
                    },
                    message: err.to_string(),
                })?;
            Self::to_json_val(prepared)
        });

        self.register_handler("worktree:remove", |_ctx, args| {
            let context_path = args.first().and_then(Value::as_str).unwrap_or("");
            let target_val = args.get(1).cloned().ok_or_else(|| RustRpcError {
                code: "INVALID_ARGUMENT".to_string(),
                message: "worktree:remove requires a WorktreeTarget.".to_string(),
            })?;
            let target: WorktreeTarget =
                serde_json::from_value(target_val).map_err(|err| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: format!("Invalid WorktreeTarget: {err}"),
                })?;
            let opts: Option<RemoveWorktreeOptions> = args
                .get(2)
                .filter(|v| !v.is_null())
                .cloned()
                .map(serde_json::from_value)
                .transpose()
                .map_err(|err| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: format!("Invalid RemoveWorktreeOptions: {err}"),
                })?;
            let mgr = GitWorktreeManager::silent();
            mgr.remove_delivery_worktree_sync(Path::new(context_path), &target, opts.as_ref())
                .map_err(|err| RustRpcError {
                    code: "WORKTREE_ERROR".to_string(),
                    message: err.to_string(),
                })?;
            Ok(Value::Bool(true))
        });

        self.register_handler("worktree:ensureExcluded", |_ctx, args| {
            let repo_root = args.first().and_then(Value::as_str).unwrap_or("");
            ensure_worktrees_excluded_sync(Path::new(repo_root)).map_err(|err| RustRpcError {
                code: "WORKTREE_ERROR".to_string(),
                message: err.to_string(),
            })?;
            Ok(Value::Bool(true))
        });

        self.register_handler("worktree:inspectRunWork", |_ctx, args| {
            let repo_root = args.first().and_then(Value::as_str).unwrap_or("");
            let run_id = args.get(1).and_then(Value::as_str).unwrap_or("");
            let wt_path = args.get(2).and_then(Value::as_str).map(Path::new);
            let info = inspect_run_work_sync(Path::new(repo_root), run_id, wt_path);
            Self::to_json_val(info)
        });

        self.register_handler("worktree:deleteRunWork", |_ctx, args| {
            let repo_root = args.first().and_then(Value::as_str).unwrap_or("");
            let run_id = args.get(1).and_then(Value::as_str).unwrap_or("");
            let wt_path = args.get(2).and_then(Value::as_str).map(Path::new);
            let res = delete_run_work_sync(Path::new(repo_root), run_id, wt_path)
                .map_err(Self::git_err)?;
            Self::to_json_val(res)
        });

        self.register_handler("worktree:removeEscapingDependencyLinks", |_ctx, args| {
            let wt_path = args.first().and_then(Value::as_str).unwrap_or("");
            let removed =
                remove_escaping_dependency_links_sync(Path::new(wt_path)).map_err(Self::git_err)?;
            Self::to_json_val(removed)
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_context() -> HostContext {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = format!("/tmp/praxis-test-profile-{nanos}");
        let settings = format!("{dir}/test-settings.json");
        let config = HostConfig::new(&dir, &settings, true, true).expect("config");
        HostContext::new(config)
    }

    #[test]
    fn dispatches_builtin_status_and_config_channels() {
        let ctx = test_context();
        let status_res = ctx.dispatch_rpc(RustRpcRequest {
            id: "req-1".to_string(),
            channel: "host:status".to_string(),
            args: vec![],
        });
        assert!(status_res.ok);
        assert_eq!(
            status_res
                .result
                .as_ref()
                .and_then(|v| v.get("protocolVersion")),
            Some(&json!(1))
        );

        let cfg_res = ctx.dispatch_rpc(RustRpcRequest {
            id: "req-2".to_string(),
            channel: "host:getConfig".to_string(),
            args: vec![],
        });
        assert!(cfg_res.ok);
        let cfg_val = cfg_res.result.expect("config result");
        assert_eq!(cfg_val.get("demoMode"), Some(&json!(true)));
        assert_eq!(cfg_val.get("e2eMode"), Some(&json!(true)));
    }

    #[test]
    fn settings_and_workspace_rpc_channels_roundtrip() {
        let ctx = test_context();
        let get_res = ctx.dispatch_rpc(RustRpcRequest {
            id: "req-s1".to_string(),
            channel: "settings:get".to_string(),
            args: vec![],
        });
        assert!(get_res.ok);
        assert_eq!(
            get_res
                .result
                .as_ref()
                .and_then(|v| v.get("startup"))
                .and_then(|s| s.get("reopenLastWorkspace")),
            Some(&json!(true))
        );

        let set_res = ctx.dispatch_rpc(RustRpcRequest {
            id: "req-s2".to_string(),
            channel: "settings:set".to_string(),
            args: vec![json!({ "startup": { "reopenLastWorkspace": false } })],
        });
        assert!(set_res.ok);
        assert_eq!(
            set_res
                .result
                .as_ref()
                .and_then(|v| v.get("startup"))
                .and_then(|s| s.get("reopenLastWorkspace")),
            Some(&json!(false))
        );

        let fname_res = ctx.dispatch_rpc(RustRpcRequest {
            id: "req-w1".to_string(),
            channel: "workspaces:fileName".to_string(),
            args: vec![json!("Client Work")],
        });
        assert!(fname_res.ok);
        assert_eq!(
            fname_res.result,
            Some(json!("client-work.workspace.praxis.json"))
        );

        let _ = std::fs::remove_dir_all(&ctx.config().user_data_dir);
    }

    #[test]
    fn returns_structured_error_for_unregistered_channel() {
        let ctx = test_context();
        let res = ctx.dispatch_rpc(RustRpcRequest {
            id: "req-missing".to_string(),
            channel: "nonexistent:channel".to_string(),
            args: vec![],
        });
        assert!(!res.ok);
        assert_eq!(
            res.error.as_ref().map(|e| e.code.as_str()),
            Some("CHANNEL_NOT_REGISTERED")
        );
    }

    #[test]
    fn custom_handler_and_event_emission_roundtrip() {
        let ctx = test_context();
        ctx.register_handler("custom:echo", |host, args| {
            host.events()
                .emit("custom:echoed", Some(json!({ "count": args.len() })));
            Ok(json!({ "received": args }))
        });

        let captured = Arc::new(RwLock::new(Vec::new()));
        let captured_clone = Arc::clone(&captured);
        ctx.events().on_event(move |env| {
            if let Ok(mut guard) = captured_clone.write() {
                guard.push(env.clone());
            }
        });

        let res = ctx.dispatch_rpc(RustRpcRequest {
            id: "req-echo".to_string(),
            channel: "custom:echo".to_string(),
            args: vec![json!("alpha"), json!(42)],
        });
        assert!(res.ok);
        assert_eq!(res.result, Some(json!({ "received": ["alpha", 42] })));

        let events = captured.read().expect("lock");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].channel, "custom:echoed");
        assert_eq!(events[0].payload, Some(json!({ "count": 2 })));
    }

    #[test]
    fn git_and_worktree_rpc_channels_roundtrip() {
        let ctx = test_context();
        let preflight = ctx.dispatch_rpc(RustRpcRequest {
            id: "req-git-1".to_string(),
            channel: "git:preflight".to_string(),
            args: vec![],
        });
        assert!(preflight.ok);
        assert_eq!(
            preflight.result.as_ref().and_then(|v| v.get("status")),
            Some(&json!("no-workspace"))
        );

        let name_res = ctx.dispatch_rpc(RustRpcRequest {
            id: "req-wt-1".to_string(),
            channel: "worktree:buildName".to_string(),
            args: vec![json!({
                "key": "TASK-516",
                "summary": "Port git CLI parser, graph builder, and worktree manager"
            })],
        });
        assert!(name_res.ok);
        assert_eq!(
            name_res.result,
            Some(json!(
                "TASK-516-port-git-cli-parser-graph-builder-and-worktree-m"
            ))
        );

        let _ = std::fs::remove_dir_all(&ctx.config().user_data_dir);
    }

    #[test]
    fn folder_and_plans_rpc_channels_roundtrip() {
        let ctx = test_context();
        let test_dir = format!("{}/plans-fixture", ctx.config().user_data_dir.display());
        let features_dir = format!("{test_dir}/features");
        let feature1_dir = format!("{features_dir}/01-feat");
        std::fs::create_dir_all(&feature1_dir).expect("create test dirs");

        let doc1 = format!("{feature1_dir}/feature.md");
        std::fs::write(
            &doc1,
            "# My Feature\n\n**Status:** In Progress\n**Type:** Feature\n**Priority:** High\n\n## Description\nTesting.",
        )
        .expect("write doc");

        // Test ensureFrontMatter under both folder and plans
        let fm_res1 = ctx.dispatch_rpc(RustRpcRequest {
            id: "req-fm-1".to_string(),
            channel: "folder:ensureFrontMatter".to_string(),
            args: vec![json!("# Title\n\nBody"), json!("Story")],
        });
        assert!(fm_res1.ok);
        let fm_res2 = ctx.dispatch_rpc(RustRpcRequest {
            id: "req-fm-2".to_string(),
            channel: "plans:ensureFrontMatter".to_string(),
            args: vec![json!("# Title\n\nBody"), json!("Story")],
        });
        assert!(fm_res2.ok);
        // Each call stamps `**Created:**` with the current millisecond, so compare without it.
        let without_created = |result: &Option<Value>| -> String {
            result
                .as_ref()
                .and_then(Value::as_str)
                .unwrap_or_default()
                .lines()
                .filter(|line| !line.starts_with("**Created:**"))
                .collect::<Vec<_>>()
                .join("\n")
        };
        assert_eq!(
            without_created(&fm_res1.result),
            without_created(&fm_res2.result)
        );
        assert!(
            fm_res1
                .result
                .expect("front matter result")
                .as_str()
                .expect("front matter text")
                .contains("**Type:** Story")
        );

        // Test discoverPlanFolders under folder and plans
        let disc_res1 = ctx.dispatch_rpc(RustRpcRequest {
            id: "req-disc-1".to_string(),
            channel: "folder:discoverPlanFolders".to_string(),
            args: vec![json!(test_dir)],
        });
        assert!(disc_res1.ok);
        let disc_res2 = ctx.dispatch_rpc(RustRpcRequest {
            id: "req-disc-2".to_string(),
            channel: "plans:discoverPlanFolders".to_string(),
            args: vec![json!(test_dir)],
        });
        assert!(disc_res2.ok);
        assert_eq!(disc_res1.result, disc_res2.result);

        // Test discoverPlans by directory path under folder and plans
        let plans_res1 = ctx.dispatch_rpc(RustRpcRequest {
            id: "req-plans-1".to_string(),
            channel: "folder:discoverPlans".to_string(),
            args: vec![json!(test_dir)],
        });
        assert!(plans_res1.ok);
        let plans_res2 = ctx.dispatch_rpc(RustRpcRequest {
            id: "req-plans-2".to_string(),
            channel: "plans:discoverPlans".to_string(),
            args: vec![json!(test_dir)],
        });
        assert!(plans_res2.ok);
        assert_eq!(plans_res1.result, plans_res2.result);

        // Test discoverPlans with connectionId in settings.json
        let settings_path = &ctx.config().settings_path;
        let settings_content = json!({
            "connections": [
                {
                    "id": "test-folder-conn",
                    "mode": "folder",
                    "settings": {
                        "roots": [test_dir]
                    }
                }
            ]
        });
        std::fs::write(
            settings_path,
            serde_json::to_string(&settings_content).expect("serialize settings"),
        )
        .expect("write settings");

        let conn_res = ctx.dispatch_rpc(RustRpcRequest {
            id: "req-conn-1".to_string(),
            channel: "folder:discoverPlans".to_string(),
            args: vec![json!("test-folder-conn")],
        });
        assert!(conn_res.ok);
        assert_eq!(conn_res.result, plans_res1.result);

        // Test discoverPlans with unknown connection returns CONNECTION_NOT_FOUND
        let missing_conn = ctx.dispatch_rpc(RustRpcRequest {
            id: "req-conn-missing".to_string(),
            channel: "folder:discoverPlans".to_string(),
            args: vec![json!("non-existent-conn")],
        });
        assert!(!missing_conn.ok);
        assert_eq!(
            missing_conn.error.as_ref().map(|e| e.code.as_str()),
            Some("CONNECTION_NOT_FOUND")
        );

        // Test parsePlanFolder under folder and plans
        let parse_res1 = ctx.dispatch_rpc(RustRpcRequest {
            id: "req-parse-1".to_string(),
            channel: "folder:parsePlanFolder".to_string(),
            args: vec![json!(test_dir), Value::Null, json!("PRAXIS")],
        });
        assert!(parse_res1.ok);
        let parse_res2 = ctx.dispatch_rpc(RustRpcRequest {
            id: "req-parse-2".to_string(),
            channel: "plans:parsePlanFolder".to_string(),
            args: vec![json!(test_dir), Value::Null, json!("PRAXIS")],
        });
        assert!(parse_res2.ok);
        assert_eq!(parse_res1.result, parse_res2.result);

        // Test readBoardConfig and writeBoardConfig under folder and plans
        let board_cfg = json!({
            "projectKey": "PRAXIS",
            "projectName": "Praxis Desktop",
            "workflow": null
        });
        let write_res = ctx.dispatch_rpc(RustRpcRequest {
            id: "req-bcfg-w".to_string(),
            channel: "plans:writeBoardConfig".to_string(),
            args: vec![json!(test_dir), board_cfg],
        });
        assert!(write_res.ok);

        let read_res1 = ctx.dispatch_rpc(RustRpcRequest {
            id: "req-bcfg-r1".to_string(),
            channel: "folder:readBoardConfig".to_string(),
            args: vec![json!(test_dir)],
        });
        assert!(read_res1.ok);
        let read_res2 = ctx.dispatch_rpc(RustRpcRequest {
            id: "req-bcfg-r2".to_string(),
            channel: "plans:readBoardConfig".to_string(),
            args: vec![json!(test_dir)],
        });
        assert!(read_res2.ok);
        assert_eq!(read_res1.result, read_res2.result);

        let _ = std::fs::remove_dir_all(&ctx.config().user_data_dir);
    }
}
