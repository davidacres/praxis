//! The stdio MCP server agent sessions use to reach the code-intelligence service (port of
//! `packages/core/src/codeIntelligence/mcpBridge.ts`). The desktop binary re-executes itself with
//! [`FLAG`]; the agent speaks newline-delimited JSON-RPC to it and every tool call becomes one
//! `rpc` invocation of the local service, so provider responses never carry local diagnostics.

use std::io::{BufRead, Write};
use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};

use super::code_intelligence::{Runtime, invoke_with};

pub const FLAG: &str = "--code-intelligence-bridge";
/// Bridge repository argument meaning "every repository this client holds a grant for".
const ALL_GRANTED: &str = "*";
const GRANT_CACHE: Duration = Duration::from_secs(10);
const MAXIMUM_REQUEST: usize = 1024 * 1024;

/// `(name, repository id, state)` of a granted repository.
type Granted = (String, String, String);

struct Bridge {
    runtime: Runtime,
    data: String,
    repository_id: String,
    client: String,
    contracts: Map<String, Value>,
    settings_path: Option<String>,
    working_directory: Option<String>,
    granted: Option<(Instant, Vec<Granted>)>,
}

fn failure(repository_id: &str, code: &str, message: &str) -> Value {
    json!({
        "schemaVersion": "1.2", "repositoryId": repository_id, "indexGeneration": null, "queryEpoch": null,
        "error": { "code": code, "message": message, "retryable": code == "CANCELLED" }
    })
}

/// Readable names for granted repositories: the root folder's name, with a short ID suffix when
/// two roots share a name (ignoring case).
fn repository_names(entries: &[(String, String, String)]) -> Vec<(String, String, String)> {
    let base = |root: &str| {
        Path::new(root.trim_end_matches(['/', '\\']))
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| "repository".into())
    };
    let mut named: Vec<(String, String, String)> = entries
        .iter()
        .map(|(id, root, state)| {
            let name = base(root);
            let same = entries
                .iter()
                .filter(|(_, other, _)| base(other).eq_ignore_ascii_case(&name))
                .count();
            let suffix: String = id.trim_start_matches("pci:repo:").chars().take(6).collect();
            let name = if same > 1 {
                format!("{name}-{suffix}")
            } else {
                name
            };
            (name, id.clone(), state.clone())
        })
        .collect();
    named.sort_by_key(|(name, _, _)| name.to_lowercase());
    named
}

impl Bridge {
    fn invoke_tool(&self, repository_id: &str, tool: &str, arguments: &Value) -> Value {
        if !self.contracts.contains_key(tool) {
            return failure(repository_id, "INVALID_ARGUMENT", "Unknown read-only tool.");
        }
        // A single-repository bridge serves exactly one repository: an omitted ID means that
        // one; any other ID is refused.
        if let Some(requested) = arguments.get("repositoryId")
            && requested.as_str() != Some(repository_id)
        {
            return failure(
                repository_id,
                "ACCESS_DENIED",
                "This bridge is scoped to one repository.",
            );
        }
        let mut arguments = arguments.as_object().cloned().unwrap_or_default();
        if let Some(mode) = self.saved_search_mode(tool, &arguments) {
            arguments.insert("mode".into(), json!(mode));
        }
        arguments.insert("repositoryId".into(), json!(repository_id));
        let payload = json!({ "tool": tool, "arguments": arguments });
        if payload.to_string().len() > MAXIMUM_REQUEST {
            return failure(
                repository_id,
                "INPUT_TOO_LARGE",
                "Query exceeds the request limit.",
            );
        }
        match invoke_with(
            &self.runtime,
            Path::new(&self.data),
            &["rpc", "--client", &self.client],
            Some(&payload),
        ) {
            Ok(value) if value.is_object() && value.get("schemaVersion").is_some() => value,
            Ok(_) => failure(
                repository_id,
                "INTERNAL_ERROR",
                "Local service returned no valid tool envelope.",
            ),
            Err(_) => failure(
                repository_id,
                "CAPABILITY_UNAVAILABLE",
                "Local code intelligence service could not start.",
            ),
        }
    }

    /// The composer's saved preference, read per query so changes apply mid-session.
    fn saved_search_mode(&self, tool: &str, arguments: &Map<String, Value>) -> Option<String> {
        if !matches!(tool, "search_code" | "search_knowledge") || arguments.contains_key("mode") {
            return None;
        }
        let settings: Value =
            serde_json::from_str(&std::fs::read_to_string(self.settings_path.as_deref()?).ok()?)
                .ok()?;
        let config = &settings["ai"]["codeIntelligence"];
        let per_project = self.working_directory.as_deref().and_then(|dir| {
            config["projectSearchModes"][dir]
                .as_str()
                .or_else(|| config["projectSearchModes"][dir.trim_end_matches('/')].as_str())
        });
        per_project
            .or_else(|| config["searchMode"].as_str())
            .filter(|m| matches!(*m, "hybrid" | "lexical" | "vector"))
            .map(str::to_owned)
    }

    fn repositories(&mut self, refresh: bool) -> Option<Vec<(String, String, String)>> {
        if !refresh
            && let Some((at, list)) = &self.granted
            && at.elapsed() < GRANT_CACHE
        {
            return Some(list.clone());
        }
        let response = invoke_with(
            &self.runtime,
            Path::new(&self.data),
            &["grants", "--client", &self.client],
            None,
        )
        .ok()?;
        let entries: Vec<(String, String, String)> = response["data"]
            .as_array()?
            .iter()
            .filter_map(|e| {
                Some((
                    e["repositoryId"].as_str()?.to_owned(),
                    e["root"].as_str()?.to_owned(),
                    e["state"].as_str()?.to_owned(),
                ))
            })
            .collect();
        let named = repository_names(&entries);
        self.granted = Some((Instant::now(), named.clone()));
        Some(named)
    }

    /// Resolves an agent-supplied repository (readable name in any case, or ID).
    fn resolve(&mut self, requested: Option<&str>) -> std::result::Result<String, Value> {
        for refresh in [false, true] {
            let available = self.repositories(refresh).ok_or_else(|| {
                failure(
                    ALL_GRANTED,
                    "CAPABILITY_UNAVAILABLE",
                    "Local code intelligence service could not list granted repositories.",
                )
            })?;
            match requested {
                None => {
                    if available.len() == 1 {
                        return Ok(available[0].1.clone());
                    }
                    if refresh {
                        let names: Vec<_> = available.iter().map(|e| e.0.clone()).collect();
                        return Err(if names.is_empty() {
                            failure(
                                ALL_GRANTED,
                                "ACCESS_DENIED",
                                "No repository has been granted to this client.",
                            )
                        } else {
                            failure(
                                ALL_GRANTED,
                                "INVALID_ARGUMENT",
                                &format!("Name the repository: {}.", names.join(", ")),
                            )
                        });
                    }
                }
                Some(requested) => {
                    let found = available
                        .iter()
                        .find(|e| e.0 == requested || e.1 == requested)
                        .or_else(|| {
                            available
                                .iter()
                                .find(|e| e.0.eq_ignore_ascii_case(requested))
                        });
                    if let Some(found) = found {
                        return Ok(found.1.clone());
                    }
                }
            }
        }
        let names: Vec<String> = self
            .repositories(false)
            .unwrap_or_default()
            .into_iter()
            .map(|e| e.0)
            .collect();
        let suffix = if names.is_empty() {
            String::new()
        } else {
            format!(" Available: {}.", names.join(", "))
        };
        Err(failure(
            requested.unwrap_or(ALL_GRANTED),
            "ACCESS_DENIED",
            &format!("Repository is not available to this client.{suffix}"),
        ))
    }

    fn tool_list(&self) -> Value {
        let multiple = self.repository_id == ALL_GRANTED;
        let read_only = json!({ "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false });
        let mut tools = Vec::new();
        if multiple {
            tools.push(json!({
                "name": "list_repositories",
                "description": "Lists the repositories these code intelligence tools can read, with their index state. Pass a name as `repository` to the other tools.",
                "inputSchema": { "type": "object", "properties": {} }, "annotations": read_only
            }));
        }
        for (name, schemas) in &self.contracts {
            let mut input = schemas["inputSchema"]
                .as_object()
                .cloned()
                .unwrap_or_default();
            let mut properties = input
                .get("properties")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            properties.remove("repositoryId");
            if multiple {
                properties.insert("repository".into(), json!({ "type": "string", "minLength": 1, "maxLength": 512,
                    "description": "Repository name from list_repositories. May be omitted when only one repository is available." }));
            }
            input.insert("properties".into(), Value::Object(properties));
            if let Some(required) = input.get("required").and_then(Value::as_array) {
                let kept: Vec<Value> = required
                    .iter()
                    .filter(|r| *r != "repositoryId")
                    .cloned()
                    .collect();
                input.insert("required".into(), Value::Array(kept));
            }
            input.insert("type".into(), json!("object"));
            let mut output = schemas["outputSchema"]
                .as_object()
                .cloned()
                .unwrap_or_default();
            output.insert("type".into(), json!("object"));
            let guidance = guidance(name).map(str::to_owned).unwrap_or_else(|| {
                format!(
                    "{} for {}.",
                    name.replace('_', " "),
                    if multiple {
                        "a granted repository"
                    } else {
                        "the registered repository"
                    }
                )
            });
            tools.push(json!({
                "name": name,
                "description": format!("{guidance} Read-only and static: results do not prove runtime behavior, and may lag edits made moments ago."),
                "inputSchema": input, "outputSchema": output, "annotations": read_only
            }));
        }
        json!({ "tools": tools })
    }

    fn call_tool(&mut self, params: &Value) -> Value {
        let respond = |result: Value| {
            json!({ "content": [{ "type": "text", "text": result.to_string() }],
                "structuredContent": result, "isError": !result["error"].is_null() })
        };
        let name = params["name"].as_str().unwrap_or_default();
        let mut arguments = params["arguments"].as_object().cloned().unwrap_or_default();
        if self.repository_id != ALL_GRANTED {
            let repository = self.repository_id.clone();
            return respond(self.invoke_tool(&repository, name, &Value::Object(arguments)));
        }
        if name == "list_repositories" {
            let list = self.repositories(true).unwrap_or_default();
            return respond(
                json!({ "repositories": list.iter().map(|e| json!({ "name": e.0, "state": e.2 })).collect::<Vec<_>>() }),
            );
        }
        let requested = arguments
            .get("repository")
            .or_else(|| arguments.get("repositoryId"))
            .cloned();
        arguments.remove("repository");
        arguments.remove("repositoryId");
        if let Some(requested) = &requested
            && !requested.is_string()
        {
            return respond(failure(
                ALL_GRANTED,
                "INVALID_ARGUMENT",
                "repository must be a string.",
            ));
        }
        match self.resolve(requested.as_ref().and_then(Value::as_str)) {
            Ok(repository) => {
                respond(self.invoke_tool(&repository, name, &Value::Object(arguments)))
            }
            Err(error) => respond(error),
        }
    }

    fn handle(&mut self, request: &Value) -> Option<Value> {
        let id = request.get("id")?.clone();
        let result = match request["method"].as_str().unwrap_or_default() {
            "initialize" => json!({
                "protocolVersion": request["params"]["protocolVersion"].as_str().unwrap_or("2025-03-26"),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "praxis-code-intelligence", "version": "1.2.0" }
            }),
            "ping" => json!({}),
            "tools/list" => self.tool_list(),
            "tools/call" => self.call_tool(&request["params"]),
            other => {
                return Some(json!({ "jsonrpc": "2.0", "id": id,
                    "error": { "code": -32601, "message": format!("Method not found: {other}") } }));
            }
        };
        Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
    }
}

fn guidance(tool: &str) -> Option<&'static str> {
    Some(match tool {
        "search_code" => {
            "Find code by concept or name when you do not know the exact identifier (\"where is session handover handled\"). Leave mode unset to follow the session composer's saved search preference, or automatic search when none is saved."
        }
        "find_symbol" => {
            "Find where a class, function, method or field is declared, by name or qualified name. Returns symbol IDs for the other tools."
        }
        "get_symbol" => "Get the declaration, kind and signature of a symbol ID.",
        "get_source" => {
            "Read the source of a symbol, file or range found by another tool, without opening the whole file."
        }
        "explain_symbol" => {
            "Get the structural facts about a symbol, with evidence and any uncertainties, as an orientation before reading its source."
        }
        "get_callers" => {
            "List what calls a symbol. Use instead of grepping for its name: it skips comments, strings and look-alike names."
        }
        "get_callees" => "List what a symbol calls.",
        "trace_flow" => {
            "Follow call paths from a symbol, outgoing or incoming, several levels deep in one call."
        }
        "find_related" => {
            "Find structural and semantic neighbours of a symbol, each with the reason it is related."
        }
        "summarize_project" => {
            "Summarize one project's components, index coverage and unresolved boundaries."
        }
        "get_index_status" => {
            "Check whether the index is current. Call it when results look empty, partial or stale."
        }
        "search_knowledge" => {
            "Search the repository's docs and plans (Markdown and similar) by concept or keyword. Leave mode unset to follow the session composer's saved search preference."
        }
        "get_knowledge_section" => "Read one docs section found by search_knowledge.",
        "find_related_knowledge" => "Find docs that mention a symbol, file or ticket.",
        _ => return None,
    })
}

/// Entry point for `praxis-desktop --code-intelligence-bridge <exe> <assembly|-> <data> <repo> <client> <contracts>`.
pub fn run(args: &[String]) -> i32 {
    let Some(at) = args.iter().position(|a| a == FLAG) else {
        return 2;
    };
    let [
        executable,
        assembly,
        data,
        repository_id,
        client,
        contracts_path,
        ..,
    ] = &args[at + 1..]
    else {
        return 2;
    };
    let Some(contracts) = std::fs::read_to_string(contracts_path)
        .ok()
        .and_then(|t| serde_json::from_str::<Map<String, Value>>(&t).ok())
    else {
        return 5;
    };
    let mut bridge = Bridge {
        runtime: Runtime {
            executable: executable.clone(),
            assembly: (assembly != "-").then(|| assembly.clone()),
            contracts: contracts_path.into(),
        },
        data: data.clone(),
        repository_id: repository_id.clone(),
        client: client.clone(),
        contracts,
        settings_path: std::env::var("PRAXIS_CODE_INTELLIGENCE_SETTINGS_PATH").ok(),
        working_directory: std::env::var("PRAXIS_CODE_INTELLIGENCE_WORKING_DIRECTORY").ok(),
        granted: None,
    };
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let Ok(request) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(response) = bridge.handle(&request) {
            let _ = writeln!(stdout, "{response}");
            let _ = stdout.flush();
        }
    }
    0
}
