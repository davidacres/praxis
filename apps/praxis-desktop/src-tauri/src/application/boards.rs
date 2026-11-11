use praxis_contracts::BackendMode;
use praxis_core::issues::{
    build_parent_validation_message, get_parent_rule, is_allowed_parent_type,
};
use praxis_host::HostContext;
use serde_json::{Value, json};
use uuid::Uuid;

use super::storage::{Catalog, PROJECTS};
use super::{Result, connections, failure, now, projects, text};

fn app_project(catalog: &Catalog, connection: &Value) -> Result<Value> {
    projects::require(
        catalog,
        connection["settings"]["projectId"]
            .as_str()
            .ok_or_else(|| failure("Project connection has no project id."))?,
    )
}

fn board(project: &Value) -> Value {
    let mut value = json!({"id": project["defaultBoardId"], "name": format!("{} Board", project["name"].as_str().unwrap_or("")), "type": "project",
        "createdAt": project["createdAt"], "projectKey": project["key"], "projectName": project["name"], "connectionId": format!("project:{}", project["id"].as_str().unwrap_or(""))});
    if project["workspaceFolder"].is_string() {
        value["locationName"] = project["workspaceFolder"].clone();
    }
    value
}

fn issue(project: &Value, item: &Value) -> Value {
    let mut value = json!({"id": item["id"], "key": item["key"], "summary": item["summary"], "description": item["description"], "issueType": item["issueType"],
        "status": item["status"], "projectKey": project["key"], "projectName": project["name"], "created": item["createdAt"], "updated": item["updatedAt"]});
    if project["workflowStages"]
        .as_array()
        .and_then(|stages| stages.last())
        .is_some_and(|stage| stage["name"] == item["status"])
    {
        value["statusCategory"] = json!("done");
    }
    if let Some(parent) = item["parentKey"].as_str() {
        value["parentKey"] = json!(parent);
        if let Some(item) = project["workItems"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|item| item["key"] == parent)
        {
            value["parentIssue"] = json!({"key": item["key"], "summary": item["summary"], "issueType": item["issueType"], "description": item["description"]});
        }
    }
    if item["origin"] == "capture" {
        value["origin"] = json!("capture");
    }
    value
}

fn details(project: &Value, key: &str) -> Result<Value> {
    let item = project["workItems"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|item| item["key"] == key)
        .ok_or_else(|| failure(format!("Work item {key} was not found.")))?;
    let mut value = issue(project, item);
    value["comments"] = json!([]);
    value["transitions"] = json!(project["workflowStages"].as_array().into_iter().flatten().filter(|stage| stage["name"] != item["status"])
        .map(|stage| json!({"id": stage["id"], "name": format!("Move to {}", stage["name"].as_str().unwrap_or("")), "toStatus": stage["name"]})).collect::<Vec<_>>());
    Ok(value)
}

fn member(filters: &Value, field: &str, value: &Value) -> bool {
    filters[field]
        .as_array()
        .is_none_or(|values| values.is_empty() || values.contains(value))
}

fn filtered(project: &Value, filters: &Value) -> Vec<Value> {
    let needle = filters["searchText"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    project["workItems"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| issue(project, item))
        .filter(|item| {
            member(filters, "projectKeys", &item["projectKey"])
                && member(filters, "statuses", &item["status"])
                && member(filters, "issueTypes", &item["issueType"])
                && (needle.is_empty()
                    || format!(
                        "{} {} {}",
                        item["key"].as_str().unwrap_or(""),
                        item["summary"].as_str().unwrap_or(""),
                        item["description"].as_str().unwrap_or("")
                    )
                    .to_lowercase()
                    .contains(&needle))
        })
        .collect()
}

fn boards_for(
    host: &HostContext,
    catalog: &Catalog,
    connection: &Value,
    filters: &Value,
) -> Result<Vec<Value>> {
    if connection["mode"] == "app" {
        let project = app_project(catalog, connection)?;
        let board = board(&project);
        let needle = filters["searchText"]
            .as_str()
            .unwrap_or("")
            .trim()
            .to_lowercase();
        let types = filters["types"].as_array();
        if !member(filters, "projectKeys", &project["key"])
            || types.is_some_and(|types| {
                !types.is_empty()
                    && !types.iter().any(|kind| {
                        kind.as_str()
                            .is_some_and(|kind| kind.eq_ignore_ascii_case("project"))
                    })
            })
            || (!needle.is_empty()
                && !format!(
                    "{} {} {}",
                    board["name"].as_str().unwrap_or(""),
                    project["key"].as_str().unwrap_or(""),
                    project["name"].as_str().unwrap_or("")
                )
                .to_lowercase()
                .contains(&needle))
        {
            return Ok(Vec::new());
        }
        Ok(vec![board])
    } else {
        let value = connections::tracker(
            host,
            catalog,
            connection["id"].as_str().unwrap_or(""),
            "tracker:getBoards",
            vec![filters.clone()],
        )?;
        Ok(value
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|mut board| {
                board["connectionId"] = connection["id"].clone();
                board
            })
            .collect())
    }
}

fn validate_parent(
    project: &Value,
    kind: &str,
    parent: Option<&str>,
    current: Option<&str>,
) -> Result<()> {
    let rule = get_parent_rule(Some(kind), BackendMode::App);
    if !rule.can_have_parent {
        if parent.is_some() {
            return Err(failure(format!("{kind} items cannot have a parent.")));
        }
        return Ok(());
    }
    let Some(parent) = parent else {
        if rule.requires_parent {
            return Err(failure(format!(
                "{} is required for {kind} items.",
                rule.default_label
            )));
        }
        return Ok(());
    };
    if current == Some(parent) {
        return Err(failure("An item cannot be its own parent."));
    }
    let item = project["workItems"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|item| item["key"] == parent)
        .ok_or_else(|| failure(format!("{} {parent} was not found.", rule.default_label)))?;
    if !is_allowed_parent_type(item["issueType"].as_str(), Some(kind), BackendMode::App) {
        return Err(failure(build_parent_validation_message(
            Some(kind),
            BackendMode::App,
            item["issueType"].as_str(),
        )));
    }
    Ok(())
}

fn app_issue(
    catalog: &mut Catalog,
    connection: &Value,
    channel: &str,
    args: &[Value],
) -> Result<Value> {
    let mut project = app_project(catalog, connection)?;
    match channel {
        "issue:list" => {
            let values = filtered(&project, args.first().unwrap_or(&Value::Null));
            let start = args.get(1).and_then(Value::as_u64).unwrap_or(0) as usize;
            let size = args.get(2).and_then(Value::as_u64).unwrap_or(25) as usize;
            Ok(
                json!({"issues": values.iter().skip(start).take(size).collect::<Vec<_>>(), "total": values.len(), "hasMore": start.saturating_add(size) < values.len()}),
            )
        }
        "issue:getFilterMetadata" => {
            let kinds: std::collections::BTreeSet<_> = project["workItems"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|item| item["issueType"].as_str())
                .collect();
            Ok(
                json!({"statuses": project["workflowStages"].as_array().into_iter().flatten().map(|stage| stage["name"].clone()).collect::<Vec<_>>(), "issueTypes": kinds}),
            )
        }
        "issue:getProjects" => {
            Ok(json!([{"id": project["id"], "key": project["key"], "name": project["name"]}]))
        }
        "issue:getSelfAssigneeLabel" => Ok(Value::Null),
        "issue:get" => details(&project, text(args, 0)?),
        "issue:getParentItems" => {
            let rule = get_parent_rule(
                args.get(2)
                    .and_then(|options| options["childIssueType"].as_str()),
                BackendMode::App,
            );
            let has_kind = args
                .get(2)
                .and_then(|options| options["childIssueType"].as_str())
                .is_some();
            let needle = args
                .get(1)
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_lowercase();
            Ok(json!(
                filtered(&project, args.first().unwrap_or(&Value::Null))
                    .into_iter()
                    .filter(|item| (!has_kind
                        || rule.allowed_parent_types.is_empty()
                        || rule
                            .allowed_parent_types
                            .iter()
                            .any(|kind| item["issueType"]
                                .as_str()
                                .is_some_and(|value| value.eq_ignore_ascii_case(kind))))
                        && (needle.is_empty()
                            || format!(
                                "{} {}",
                                item["key"].as_str().unwrap_or(""),
                                item["summary"].as_str().unwrap_or("")
                            )
                            .to_lowercase()
                            .contains(&needle)))
                    .collect::<Vec<_>>()
            ))
        }
        "issue:addComment" => Err(failure(
            "Comments are not available on local project tickets yet.",
        )),
        "issue:create" | "issue:update" | "issue:delete" | "issue:transition" => {
            let mut items = project["workItems"].as_array().cloned().unwrap_or_default();
            let key;
            if channel == "issue:create" {
                let input = args
                    .first()
                    .ok_or_else(|| failure("Work item input is required."))?;
                if input["projectKey"] != project["key"] {
                    return Err(failure("That project is not available."));
                }
                let kind = input["issueType"].as_str().unwrap_or("Task").trim();
                let kind = if kind.is_empty() { "Task" } else { kind };
                let parent = input["parentKey"]
                    .as_str()
                    .map(str::trim)
                    .filter(|value| !value.is_empty());
                validate_parent(&project, kind, parent, None)?;
                let sequence = items
                    .iter()
                    .filter_map(|item| {
                        item["key"]
                            .as_str()?
                            .rsplit('-')
                            .next()?
                            .parse::<u64>()
                            .ok()
                    })
                    .max()
                    .unwrap_or(0)
                    .checked_add(1)
                    .ok_or_else(|| failure("Work item sequence is exhausted."))?;
                key = format!("{}-{sequence}", project["key"].as_str().unwrap_or(""));
                let mut item = json!({"id": format!("{}-item-{}", project["id"].as_str().unwrap_or(""), Uuid::new_v4()), "key": key,
                    "summary": input["summary"].as_str().ok_or_else(|| failure("Summary must be a string."))?.trim(), "description": input["description"].as_str().unwrap_or("").trim(),
                    "issueType": kind, "status": project["workflowStages"][0]["name"], "createdAt": now(), "updatedAt": now()});
                if let Some(parent) = parent {
                    item["parentKey"] = json!(parent);
                }
                if input["origin"] == "capture" {
                    item["origin"] = json!("capture");
                }
                items.push(item);
            } else {
                key = text(args, 0)?.to_owned();
                let index = items
                    .iter()
                    .position(|item| item["key"] == key)
                    .ok_or_else(|| failure(format!("Work item {key} was not found.")))?;
                if channel == "issue:delete" {
                    items.remove(index);
                } else if channel == "issue:transition" {
                    let stage = project["workflowStages"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .find(|stage| stage["id"] == args[1])
                        .ok_or_else(|| failure("Workflow stage was not found."))?;
                    items[index]["status"] = stage["name"].clone();
                    items[index]["updatedAt"] = json!(now());
                } else {
                    let input = args
                        .get(1)
                        .filter(|input| input.is_object())
                        .ok_or_else(|| failure("Work item patch is required."))?;
                    let kind = input["issueType"]
                        .as_str()
                        .filter(|value| !value.trim().is_empty())
                        .or(items[index]["issueType"].as_str())
                        .unwrap_or("Task");
                    let parent = input
                        .get("parentKey")
                        .unwrap_or(&items[index]["parentKey"])
                        .as_str()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_owned);
                    validate_parent(&project, kind, parent.as_deref(), Some(&key))?;
                    for field in ["summary", "description", "issueType"] {
                        if let Some(change) = input.get(field) {
                            items[index][field] = json!(
                                change
                                    .as_str()
                                    .ok_or_else(|| failure(format!("{field} must be a string.")))?
                                    .trim()
                            );
                        }
                    }
                    if input.get("parentKey").is_some() {
                        if let Some(parent) = parent {
                            items[index]["parentKey"] = json!(parent);
                        } else {
                            items[index]
                                .as_object_mut()
                                .ok_or_else(|| failure("Invalid work item."))?
                                .remove("parentKey");
                        }
                    }
                    items[index]["updatedAt"] = json!(now());
                }
            }
            project["workItems"] = json!(items);
            project["updatedAt"] = json!(now());
            catalog.replace(PROJECTS, project.clone(), None);
            if channel == "issue:delete" || channel == "issue:transition" {
                Ok(Value::Null)
            } else {
                details(&project, &key)
            }
        }
        _ => Err(failure("Unknown app issue operation.")),
    }
}

pub fn dispatch(
    host: &HostContext,
    catalog: &mut Catalog,
    channel: &str,
    args: &[Value],
) -> Result<Value> {
    if channel == "board:list" {
        let filters = args.first().cloned().unwrap_or_else(|| json!({}));
        let id = args.get(1).and_then(Value::as_str);
        let candidates = if let Some(id) = id {
            vec![connections::require(catalog, id)?]
        } else {
            connections::list(catalog)
        };
        let mut boards = Vec::new();
        for connection in candidates {
            match boards_for(host, catalog, &connection, &filters) {
                Ok(values) => boards.extend(values),
                Err(error) if id.is_none() => eprintln!(
                    "Skipping unavailable connection {}: {}",
                    connection["id"], error.message
                ),
                Err(error) => return Err(error),
            }
        }
        return Ok(json!(boards));
    }
    if channel == "board:get" {
        let input = args.first().ok_or_else(|| failure("Board is required."))?;
        let id = input["connectionId"]
            .as_str()
            .ok_or_else(|| failure("Board connection id is required."))?;
        let connection = connections::require(catalog, id)?;
        if connection["mode"] != "app" {
            return connections::tracker(
                host,
                catalog,
                id,
                "tracker:getBoardDetails",
                vec![input.clone()],
            );
        }
        let project = app_project(catalog, &connection)?;
        let issues: Vec<_> = project["workItems"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|item| issue(&project, item))
            .collect();
        let stages = project["workflowStages"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        return Ok(
            json!({"board": board(&project), "issues": issues, "columnStatusOrder": stages.iter().map(|stage| stage["name"].clone()).collect::<Vec<_>>(),
            "columns": stages.iter().map(|stage| json!({"id": stage["id"], "name": stage["name"], "issues": issues.iter().filter(|item| item["status"] == stage["name"]).collect::<Vec<_>>()})).collect::<Vec<_>>() }),
        );
    }
    let (target, index) = match channel {
        "issue:list" => ("tracker:getIssues", 3),
        "issue:getFilterMetadata" => ("tracker:getFilterMetadata", 1),
        "issue:get" => ("tracker:getIssue", 1),
        "issue:create" => ("tracker:createIssue", 1),
        "issue:update" => ("tracker:updateIssue", 2),
        "issue:delete" => ("tracker:deleteIssue", 1),
        "issue:transition" => ("tracker:transitionIssue", 2),
        "issue:addComment" => ("tracker:addComment", 2),
        "issue:getSelfAssigneeLabel" => ("tracker:getSelfAssigneeLabel", 0),
        "issue:getProjects" => ("tracker:getProjects", 0),
        "issue:getParentItems" => ("tracker:getParentItems", 3),
        _ => return Err(failure("Unknown issue operation.")),
    };
    let id = args
        .get(index)
        .and_then(Value::as_str)
        .ok_or_else(|| failure("Choose a connection before working with issues."))?;
    let connection = connections::require(catalog, id)?;
    if channel == "issue:transition" {
        let transition_id = text(args, 1)?;
        let target = if connection["mode"] == "app" {
            let project = app_project(catalog, &connection)?;
            project["workflowStages"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|stage| stage["id"] == transition_id)
                .map(|stage| stage["name"].clone())
        } else {
            connections::tracker(
                host,
                catalog,
                id,
                "tracker:getTransitions",
                vec![json!(text(args, 0)?)],
            )?
            .as_array()
            .into_iter()
            .flatten()
            .find(|transition| transition["id"] == transition_id)
            .map(|transition| transition["toStatus"].clone())
        };
        if target.as_ref().and_then(Value::as_str).is_some_and(|name| {
            ["done", "closed", "resolved", "complete", "completed"]
                .contains(&name.trim().to_lowercase().as_str())
        }) && let Some(raw) =
            super::storage::read(&host.config().user_data_dir.join("workflows.json"))?
        {
            let workflows: Value = serde_json::from_str(&raw).map_err(failure)?;
            if let Some(run) = workflows["praxis.workflowRuns.v1"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|run| {
                    run["issueKey"] == args[0]
                        && run["definition"]["trigger"] == "ticket"
                        && run["status"] != "succeeded"
                })
            {
                return Err(failure(format!(
                    "Cannot complete {} while ticket workflow {} is {}.",
                    text(args, 0)?,
                    run["definition"]["name"],
                    run["status"]
                )));
            }
        }
    }
    if connection["mode"] == "app" {
        app_issue(catalog, &connection, channel, &args[..index])
    } else {
        connections::tracker(host, catalog, id, target, args[..index].to_vec())
    }
}
