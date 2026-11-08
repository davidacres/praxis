//! Shell-agnostic service container (`HostContext`) and typed RPC channel dispatcher.

use std::collections::BTreeMap;
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
        let ctx = Self {
            config: Arc::new(config),
            events: HostEventBus::default(),
            secrets: HostSecretStore::new(),
            settings,
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
            let parsed =
                parse_plan_folder(root, workflow.as_deref()).map_err(|msg| RustRpcError {
                    code: "FOLDER_PARSE_ERROR".to_string(),
                    message: msg,
                })?;
            let dep_keys = resolve_plan_dependency_keys(&parsed, project_key);
            Ok(json!({
                "parsed": parsed,
                "dependencyKeys": dep_keys,
            }))
        });

        self.register_handler("folder:discoverPlanFolders", |_ctx, args| {
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
            let root = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: "folder:readBoardConfig requires a root path.".to_string(),
                })?;
            serde_json::to_value(read_board_config_file(Path::new(root))).map_err(|err| {
                RustRpcError {
                    code: "INTERNAL_ERROR".to_string(),
                    message: err.to_string(),
                }
            })
        });

        self.register_handler("folder:writeBoardConfig", |_ctx, args| {
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
            let cfg: BoardConfigFile =
                serde_json::from_value(cfg_val).map_err(|err| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: format!("Invalid BoardConfigFile: {err}"),
                })?;
            write_board_config_file(Path::new(root), &cfg).map_err(|err| RustRpcError {
                code: "IO_ERROR".to_string(),
                message: err.to_string(),
            })?;
            Ok(Value::Bool(true))
        });

        self.register_handler("folder:ensureFrontMatter", |_ctx, args| {
            let content = args.first().and_then(Value::as_str).unwrap_or_default();
            let kind_str = args.get(1).and_then(Value::as_str).unwrap_or("Task");
            let issue_type = IssueType::parse_loose(kind_str).unwrap_or(IssueType::Task);
            Ok(Value::String(ensure_front_matter(content, issue_type)))
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
}
