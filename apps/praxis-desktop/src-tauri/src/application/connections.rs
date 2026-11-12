use praxis_contracts::RustRpcRequest;
use praxis_host::HostContext;
use serde_json::{Value, json};

use super::storage::Catalog;
use super::{Result, failure, text};

fn connection(raw: &Value) -> Result<Value> {
    let id = raw["id"].as_str().unwrap_or("").trim();
    let name = raw["name"].as_str().unwrap_or("").trim();
    let mode = match raw["mode"].as_str().unwrap_or("").trim() {
        "jira" => "jiracloud",
        mode => mode,
    };
    if id.is_empty()
        || name.is_empty()
        || ![
            "jiracloud",
            "demo",
            "github",
            "gitlab",
            "folder",
            "app",
            "project",
        ]
        .contains(&mode)
    {
        return Err(failure(
            "A valid connection id, name and backend mode are required.",
        ));
    }
    Ok(
        json!({"id": id, "name": name, "mode": mode, "settings": raw.get("settings").filter(|settings| settings.is_object()).cloned().unwrap_or_else(|| json!({}))}),
    )
}

pub fn list(catalog: &Catalog) -> Vec<Value> {
    let mut seen = std::collections::BTreeSet::new();
    catalog
        .list("connections")
        .iter()
        .filter_map(|value| connection(value).ok())
        .filter(|value| seen.insert(value["id"].as_str().unwrap_or("").to_owned()))
        .collect()
}

pub fn require(catalog: &Catalog, id: &str) -> Result<Value> {
    list(catalog)
        .into_iter()
        .find(|connection| connection["id"] == id)
        .ok_or_else(|| failure(format!("Connection {id} was not found.")))
}

fn board(raw: &Value) -> Result<Value> {
    let connection = raw["connectionId"].as_str().unwrap_or("").trim();
    let board = raw["boardId"].as_str().unwrap_or("").trim();
    if connection.is_empty() || board.is_empty() {
        return Err(failure("Tracked boards require connectionId and boardId."));
    }
    let mut result = json!({"connectionId": connection, "boardId": board});
    if let Some(name) = raw["displayName"]
        .as_str()
        .filter(|name| !name.trim().is_empty())
    {
        result["displayName"] = json!(name.trim());
    }
    Ok(result)
}

pub fn tracked(catalog: &Catalog) -> Vec<Value> {
    catalog
        .list("boards")
        .iter()
        .filter_map(|value| board(value).ok())
        .collect()
}

fn sync_folder_identity(
    host: &HostContext,
    catalog: &mut Catalog,
    connection: &Value,
) -> Result<()> {
    let input = tracker_input(host, connection)?;
    for root in input["folderConfig"]["folderRoots"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        for plans in praxis_core::folder::discover_plan_folders(root).map_err(failure)? {
            let root = std::path::Path::new(&plans.plans_root_path);
            let mut config = praxis_core::folder::read_board_config_file(root);
            let settings = &connection["settings"];
            config.project_key = settings["projectKey"]
                .as_str()
                .filter(|value| !value.is_empty())
                .map(str::to_owned);
            config.project_name = settings["projectName"]
                .as_str()
                .filter(|value| !value.is_empty())
                .map(str::to_owned);
            config.allow_issue_creation = Some(settings["allowIssueCreation"] == true);
            catalog.stage(
                root.join(praxis_core::folder::BOARD_CONFIG_FILENAME),
                serde_json::to_value(config).map_err(failure)?,
            )?;
        }
    }
    Ok(())
}

pub fn tracker_input(host: &HostContext, connection: &Value) -> Result<Value> {
    let settings = &connection["settings"];
    let mode = connection["mode"].as_str().unwrap_or("");
    let id = connection["id"].as_str().unwrap_or("");
    let provider_key = if mode == "github" {
        "githubPat"
    } else {
        "gitlabApiKey"
    };
    let secret = host
        .secrets()
        .get(&format!("praxis.connection.{id}.{provider_key}"))
        .or_else(|| {
            host.secrets()
                .get(&format!("praxis.connection.{id}.apiKey"))
        });
    match mode {
        "folder" => {
            let roots = settings["roots"]
                .as_array()
                .map(|roots| {
                    roots
                        .iter()
                        .filter_map(Value::as_str)
                        .filter(|value| !value.trim().is_empty())
                        .map(str::to_owned)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_else(|| {
                    settings["path"]
                        .as_str()
                        .filter(|path| !path.trim().is_empty())
                        .map(|path| vec![path.trim().to_owned()])
                        .unwrap_or_default()
                });
            Ok(
                json!({"mode": "folder", "folderConfig": {"folderRoots": roots, "projectKey": settings["projectKey"].as_str().unwrap_or(""),
                "projectName": settings["projectName"].as_str().unwrap_or(""), "allowIssueCreation": settings["allowIssueCreation"] == true, "defaultPageSize": 25,
                "prefersConfiguredIdentity": settings["projectId"].is_string()}}),
            )
        }
        "github" => Ok(
            json!({"mode": "github", "githubConfig": {"owner": settings["owner"].as_str().unwrap_or(""), "repo": settings["repo"].as_str().unwrap_or(""),
            "apiUrl": settings["url"].as_str().unwrap_or(""), "apiKey": secret.as_deref().or(settings["pat"].as_str()).unwrap_or(""),
            "allowIssueCreation": settings["allowIssueCreation"] == true, "defaultPageSize": 25}}),
        ),
        "gitlab" => Ok(
            json!({"mode": "gitlab", "gitlabConfig": {"url": settings["url"].as_str().unwrap_or(""), "projectPath": settings["projectPath"].as_str().unwrap_or(""),
            "listAllAccessibleBoards": settings["listAllAccessibleBoards"] == true, "selectedBoardRefs": settings["selectedBoardRefs"].as_array().cloned().unwrap_or_default(),
            "apiKey": secret.as_deref().or(settings["apiKey"].as_str()).unwrap_or(""), "allowIssueCreation": settings["allowIssueCreation"] == true, "defaultPageSize": 25}}),
        ),
        "jiracloud" => {
            let secret_named = |name: &str| {
                host.secrets()
                    .get(&format!("praxis.connection.{id}.{name}"))
                    .unwrap_or_default()
            };
            let text = |key: &str| settings[key].as_str().unwrap_or("").trim().to_owned();
            // The form stores arguments as one-per-line text; a seeded file may hold an array.
            let args: Vec<String> = match &settings["stdioArgs"] {
                Value::Array(items) => items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect(),
                Value::String(lines) => lines
                    .lines()
                    .map(str::trim)
                    .filter(|line| !line.is_empty())
                    .map(str::to_owned)
                    .collect(),
                _ => Vec::new(),
            };
            let mut headers = serde_json::Map::new();
            if let Some(map) = settings["httpHeaders"].as_object() {
                for (name, value) in map {
                    if let Some(value) = value.as_str() {
                        headers.insert(name.clone(), json!(value));
                    }
                }
            }
            Ok(json!({"mode": "jiracloud", "jiraConfig": {
                "connectionType": text("connectionType"), "stdioCommand": text("stdioCommand"), "stdioArgs": args, "stdioCwd": text("stdioCwd"),
                "httpUrl": text("httpUrl"), "httpHeaders": headers, "authMethod": text("jiraAuthMethod"), "apiEmail": text("jiraApiEmail"),
                "apiToken": secret_named("jiraApiToken"), "oauthClientId": text("jiraOAuthClientId"), "oauthClientSecret": secret_named("jiraOAuthClientSecret"),
                "oauthScope": text("jiraOAuthScope"), "oauthIssuer": text("jiraOAuthIssuer"), "oauthAuthorizationEndpoint": text("jiraOAuthAuthorizationEndpoint"),
                "oauthTokenEndpoint": text("jiraOAuthTokenEndpoint"), "siteUrl": text("url"), "connectionId": id, "timeoutMs": 30000, "defaultPageSize": 25
            }}))
        }
        _ => Err(failure(format!(
            "The {mode} desktop backend is not available in the Tauri shell yet."
        ))),
    }
}

pub fn tracker(
    host: &HostContext,
    catalog: &Catalog,
    id: &str,
    channel: &str,
    args: Vec<Value>,
) -> Result<Value> {
    let connection = require(catalog, id)?;
    let mut input = vec![tracker_input(host, &connection)?];
    input.extend(args);
    let response = host.dispatch_rpc(RustRpcRequest {
        id: "desktop-tracker".into(),
        channel: channel.into(),
        args: input,
    });
    if response.ok {
        Ok(response.result.unwrap_or(Value::Null))
    } else {
        Err(response
            .error
            .unwrap_or_else(|| failure("Tracker returned no error.")))
    }
}

pub fn dispatch(
    host: &HostContext,
    catalog: &mut Catalog,
    channel: &str,
    args: &[Value],
    active: Option<&str>,
) -> Result<Value> {
    match channel {
        "folder:discoverPlans" => {
            let connection = require(catalog, text(args, 0)?)?;
            if connection["mode"] != "folder" {
                return Err(failure("Choose a folder connection."));
            }
            let payload = tracker_input(host, &connection)?;
            let mut found = Vec::new();
            let mut seen = std::collections::BTreeSet::new();
            for root in payload["folderConfig"]["folderRoots"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                for plans in praxis_core::folder::discover_plan_folders(root).map_err(failure)? {
                    if seen.insert(plans.plans_root_path.clone()) {
                        found.push(plans);
                    }
                }
            }
            Ok(json!(found))
        }
        "connection:list" => Ok(json!(list(catalog))),
        "connection:getTrackedBoards" => Ok(json!(
            tracked(catalog)
                .into_iter()
                .filter(
                    |board| board["connectionId"] == args.first().cloned().unwrap_or(Value::Null)
                )
                .collect::<Vec<_>>()
        )),
        "connection:generateId" => {
            let mut base = String::new();
            for ch in text(args, 0)?.trim().to_lowercase().chars() {
                if ch.is_ascii_alphanumeric() {
                    base.push(ch);
                } else if !base.ends_with('-') && !base.is_empty() {
                    base.push('-');
                }
            }
            base = base.trim_matches('-').chars().take(48).collect();
            if base.is_empty() {
                base = "connection".into();
            }
            let existing = list(catalog);
            let mut id = base.clone();
            let mut suffix = 2;
            while existing.iter().any(|value| value["id"] == id) {
                id = format!("{base}-{suffix}");
                suffix += 1;
            }
            Ok(json!(id))
        }
        "connection:add" | "connection:update" => {
            let value = connection(
                args.first()
                    .ok_or_else(|| failure("Connection input is required."))?,
            )?;
            let existing = list(catalog)
                .into_iter()
                .find(|existing| existing["id"] == value["id"]);
            if channel == "connection:add" && existing.is_some() {
                return Err(failure("A connection with that id already exists."));
            }
            if channel == "connection:update" {
                let existing = existing.ok_or_else(|| failure("The connection was not found."))?;
                if existing["mode"] != value["mode"] {
                    return Err(failure(
                        "A connection backend type cannot be changed after creation.",
                    ));
                }
            }
            catalog.replace("connections", value.clone(), active);
            if channel == "connection:update" && value["mode"] == "folder" {
                // Like Electron, unreadable plan roots must not block saving settings.
                if let Err(error) = sync_folder_identity(host, catalog, &value) {
                    eprintln!("Folder identity refresh failed: {}", error.message);
                }
            }
            Ok(Value::Null)
        }
        "connection:remove" => {
            let id = text(args, 0)?;
            if tracked(catalog)
                .iter()
                .any(|board| board["connectionId"] == id)
            {
                return Err(failure(
                    "Remove the tracked boards before removing the connection.",
                ));
            }
            catalog.set(
                "connections",
                list(catalog)
                    .into_iter()
                    .filter(|value| value["id"] != id)
                    .collect(),
                active,
            );
            Ok(Value::Null)
        }
        "connection:addTrackedBoards" => {
            let additions = args
                .first()
                .and_then(Value::as_array)
                .ok_or_else(|| failure("Tracked boards must be an array."))?;
            let mut values = tracked(catalog);
            for value in additions {
                let value = board(value)?;
                if !values.iter().any(|old| {
                    old["connectionId"] == value["connectionId"]
                        && old["boardId"] == value["boardId"]
                }) {
                    values.push(value);
                }
            }
            catalog.set("boards", values, active);
            Ok(Value::Null)
        }
        "connection:removeTrackedBoard" => {
            let id = text(args, 0)?;
            let board_id = text(args, 1)?;
            catalog.set(
                "boards",
                tracked(catalog)
                    .into_iter()
                    .filter(|board| board["connectionId"] != id || board["boardId"] != board_id)
                    .collect(),
                active,
            );
            Ok(Value::Null)
        }
        "connection:updateTrackedBoard" => {
            let value = board(
                args.first()
                    .ok_or_else(|| failure("Tracked board is required."))?,
            )?;
            let mut values = tracked(catalog);
            let index = values
                .iter()
                .position(|old| {
                    old["connectionId"] == value["connectionId"]
                        && old["boardId"] == value["boardId"]
                })
                .ok_or_else(|| failure("Tracked board was not found."))?;
            values[index] = value;
            catalog.set("boards", values, active);
            Ok(Value::Null)
        }
        "connection:check" => {
            let connection = require(catalog, text(args, 0)?)?;
            if connection["mode"] == "app" {
                super::projects::require(
                    catalog,
                    connection["settings"]["projectId"]
                        .as_str()
                        .ok_or_else(|| failure("Project connection has no project id."))?,
                )?;
                Ok(
                    json!({"status": "ok", "message": "App-managed project storage is ready.", "toolCount": 0, "projectCount": 1}),
                )
            } else {
                tracker(
                    host,
                    catalog,
                    text(args, 0)?,
                    "tracker:checkConnection",
                    vec![],
                )
            }
        }
        "connection:setSecret" => {
            let connection_id = text(args, 0)?;
            let name = text(args, 1)?;
            let key = format!("praxis.connection.{connection_id}.{name}");
            let value = args.get(2).and_then(Value::as_str).unwrap_or_default();
            if value.is_empty() {
                host.secrets().delete(&key);
            } else {
                host.secrets().set(&key, value);
            }
            Ok(Value::Null)
        }
        "connection:hasSecret" => {
            let connection_id = text(args, 0)?;
            let name = text(args, 1)?;
            let key = format!("praxis.connection.{connection_id}.{name}");
            Ok(json!(host.secrets().has(&key)))
        }
        _ => Err(failure("Unknown connection operation.")),
    }
}
