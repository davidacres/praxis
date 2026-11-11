//! The in-memory demo backend (`--demo`). A port of `packages/core/src/demo/demoService.ts`.
//!
//! Data stays in the JSON shapes the renderer already consumes (`serde_json::Value`), so the
//! wire format is identical to the TypeScript service. Fixtures are generated from that
//! service by `scripts/generate-demo-fixtures.mjs`. State lives for the life of the instance
//! and is lost on exit, exactly like the original.

use std::collections::HashMap;
use std::sync::Mutex;

use chrono::{SecondsFormat, Utc};
use praxis_contracts::BackendMode;
use praxis_core::issues::{
    build_parent_validation_message, get_parent_rule, is_allowed_parent_type, normalize_issue_type_label,
};
use serde_json::{Map, Value, json};

/// Workflow columns, shown even when no issue is in a status.
pub const DEMO_BOARD_STATUS_ORDER: [&str; 5] = ["Backlog", "To Do", "In Progress", "Blocked", "Done"];
pub const DEMO_CURRENT_USER: &str = "Alex Agent";

type Result<T> = std::result::Result<T, String>;

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn s<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_default()
}

fn strings(value: &Value, key: &str) -> Vec<String> {
    value[key]
        .as_array()
        .map(|items| items.iter().filter_map(Value::as_str).map(str::to_owned).collect())
        .unwrap_or_default()
}

fn status_category(status: &str) -> &'static str {
    match status {
        "Done" => "done",
        "In Progress" | "Blocked" => "indeterminate",
        _ => "todo",
    }
}

fn transition_set(status: &str) -> Vec<Value> {
    let t = |id: &str, name: &str, to: &str| json!({ "id": id, "name": name, "toStatus": to });
    match status {
        "Backlog" => vec![t("ready-for-work", "Ready for Work", "To Do"), t("start-progress", "Start Progress", "In Progress")],
        "To Do" => vec![
            t("send-backlog", "Move to Backlog", "Backlog"),
            t("start-progress", "Start Progress", "In Progress"),
            t("mark-done", "Done", "Done"),
        ],
        "In Progress" => vec![t("mark-done", "Done", "Done"), t("block", "Block", "Blocked")],
        "Blocked" => vec![t("resume", "Resume", "In Progress")],
        _ => Vec::new(),
    }
}

fn ci_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| a.cmp(b))
}

/// Most recently updated first, ties broken by key ascending.
pub fn sort_issues_by_updated(issues: &mut [Value]) {
    issues.sort_by(|left, right| s(right, "updated").cmp(s(left, "updated")).then_with(|| s(left, "key").cmp(s(right, "key"))));
}

fn parent_reference(issue: &Value) -> Value {
    json!({ "key": issue["key"], "summary": issue["summary"], "issueType": issue["issueType"], "description": issue["description"] })
}

fn issue_summary(issue: &Value, by_key: Option<&HashMap<String, &Value>>) -> Value {
    let mut out = Map::new();
    let mut put = |key: &str, value: Value| {
        if !value.is_null() {
            out.insert(key.to_owned(), value);
        }
    };
    put("id", issue["id"].clone());
    put("key", issue["key"].clone());
    put("summary", issue["summary"].clone());
    put("status", issue["status"].clone());
    put("statusCategory", json!(status_category(s(issue, "status"))));
    put("issueType", issue["issueType"].clone());
    put("projectKey", issue["projectKey"].clone());
    put("projectName", issue["projectName"].clone());
    put("parentKey", issue["parent"].clone());
    if let (Some(parent), Some(map)) = (issue["parent"].as_str(), by_key)
        && let Some(parent_issue) = map.get(parent)
    {
        put("parentIssue", parent_reference(parent_issue));
    }
    if issue["assigneeKind"] != "none" {
        put("assignee", issue["assigneeDisplayName"].clone());
    }
    put("priority", issue["priority"].clone());
    put("created", issue["created"].clone());
    put("updated", issue["updated"].clone());
    put("browseUrl", json!(format!("https://example.com/praxis-demo/{}", s(issue, "key"))));
    put("description", issue["description"].clone());
    if issue["subTasks"].as_array().is_some_and(|tasks| !tasks.is_empty()) {
        put("subTasks", issue["subTasks"].clone());
    }
    put("raw", issue.clone());
    Value::Object(out)
}

fn issue_details(issue: &Value, parent: Option<&Value>) -> Value {
    let mut details = issue_summary(issue, None);
    if let Some(parent) = parent {
        details["parentIssue"] = parent_reference(parent);
    }
    details["transitions"] = json!(transition_set(s(issue, "status")));
    let mut comments = issue["comments"].as_array().cloned().unwrap_or_default();
    comments.sort_by(|a, b| s(b, "created").cmp(s(a, "created")));
    details["comments"] = json!(comments);
    if issue["linkedIssues"].as_array().is_some_and(|items| !items.is_empty()) {
        details["linkedIssues"] = issue["linkedIssues"].clone();
    }
    if issue["attachments"].as_array().is_some_and(|items| !items.is_empty()) {
        details["attachments"] = issue["attachments"].clone();
    }
    details
}

fn board_view(board: &Value) -> Value {
    json!({
        "id": board["id"], "name": board["name"], "type": board["type"], "createdBy": board["createdBy"],
        "createdAt": board["createdAt"], "projectKey": board["projectKey"], "projectName": board["projectName"],
        "locationName": board["locationName"], "raw": board
    })
}

fn unique_sorted(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut found: Vec<String> = values.into_iter().filter(|v| !v.trim().is_empty()).collect();
    found.sort_by(|a, b| ci_cmp(a, b));
    found.dedup();
    found
}

/// One column per canonical status (empty placeholders included), then any other status.
fn build_board_columns(issues: &[Value], order: &[&str]) -> Vec<Value> {
    let mut by_status: Vec<(String, Vec<Value>)> = Vec::new();
    for issue in issues {
        let status = Some(s(issue, "status")).filter(|status| !status.is_empty()).unwrap_or("Unknown").to_owned();
        match by_status.iter_mut().find(|(name, _)| *name == status) {
            Some((_, bucket)) => bucket.push(issue.clone()),
            None => by_status.push((status, vec![issue.clone()])),
        }
    }
    let column = |name: &str| {
        let mut bucket = by_status.iter().find(|(n, _)| n == name).map(|(_, b)| b.clone()).unwrap_or_default();
        let category = bucket.first().map(|issue| issue["statusCategory"].clone()).unwrap_or(Value::Null);
        sort_issues_by_updated(&mut bucket);
        let mut column = json!({ "id": format!("status:{name}"), "name": name, "issues": bucket });
        if !category.is_null() {
            column["statusCategory"] = category;
        }
        column
    };
    let mut columns: Vec<Value> = order.iter().map(|name| column(name)).collect();
    for (name, _) in &by_status {
        if !order.contains(&name.as_str()) {
            columns.push(column(name));
        }
    }
    columns
}

struct State {
    issues: Vec<Value>,
    boards: Vec<Value>,
}

fn seed() -> State {
    let fixtures: Value = serde_json::from_str(include_str!("demo_fixtures.json")).unwrap_or_else(|_| json!({}));
    State {
        issues: fixtures["issues"].as_array().cloned().unwrap_or_default(),
        boards: fixtures["boards"].as_array().cloned().unwrap_or_default(),
    }
}

/// The demo tracker. All methods are synchronous; nothing here waits on I/O.
pub struct DemoService {
    state: Mutex<State>,
    default_page_size: usize,
}

impl Default for DemoService {
    fn default() -> Self {
        Self::new(25)
    }
}

impl DemoService {
    #[must_use]
    pub fn new(default_page_size: usize) -> Self {
        Self { state: Mutex::new(seed()), default_page_size }
    }

    #[must_use]
    pub fn default_page_size(&self) -> usize {
        self.default_page_size
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, State>> {
        self.state.lock().map_err(|_| "Demo state is unavailable.".to_owned())
    }

    pub fn reset(&self) -> Result<()> {
        *self.lock()? = seed();
        Ok(())
    }

    #[must_use]
    pub fn projects() -> Vec<Value> {
        vec![
            json!({ "id": "demo-project-app", "key": "APP", "name": "Application Platform" }),
            json!({ "id": "demo-project-ops", "key": "OPS", "name": "Operations" }),
        ]
    }

    #[must_use]
    pub fn check_connection() -> Value {
        let count = Self::projects().len();
        json!({
            "status": "ok",
            "message": format!("Demo mode active. {count} demo project(s) loaded."),
            "toolCount": 0, "projectCount": count, "serverName": "demo-mode"
        })
    }

    #[must_use]
    pub fn self_assignee_label() -> &'static str {
        DEMO_CURRENT_USER
    }

    fn matches(state: &State, issue: &Value, filters: &Value) -> bool {
        if let Some(board_id) = filters["boardId"].as_str().filter(|id| !id.is_empty()) {
            let on_board = state
                .boards
                .iter()
                .find(|board| board["id"] == board_id)
                .is_some_and(|board| strings(board, "issueKeys").iter().any(|key| key == s(issue, "key")));
            if !on_board {
                return false;
            }
        }
        let listed = |field: &str, value: &str| {
            let wanted = strings(filters, field);
            wanted.is_empty() || wanted.iter().any(|w| w == value)
        };
        if !listed("projectKeys", s(issue, "projectKey")) || !listed("statuses", s(issue, "status")) || !listed("issueTypes", s(issue, "issueType")) {
            return false;
        }
        if filters["assigneeMode"] == "me" && issue["assigneeKind"] != "me" {
            return false;
        }
        if let Some(parent) = filters["parentKey"].as_str().filter(|p| !p.is_empty())
            && issue["parent"] != parent
        {
            return false;
        }
        let query = s(filters, "searchText").trim().to_lowercase();
        query.is_empty()
            || format!("{} {} {}", s(issue, "key"), s(issue, "summary"), s(issue, "description")).to_lowercase().contains(&query)
    }

    /// `{ issues, total, hasMore }`.
    pub fn get_issues(&self, filters: &Value, start_at: usize, page_size: usize) -> Result<Value> {
        let state = self.lock()?;
        let by_key: HashMap<String, &Value> = state.issues.iter().map(|issue| (s(issue, "key").to_owned(), issue)).collect();
        let mut matching: Vec<Value> = state
            .issues
            .iter()
            .filter(|issue| Self::matches(&state, issue, filters))
            .map(|issue| issue_summary(issue, Some(&by_key)))
            .collect();
        sort_issues_by_updated(&mut matching);
        let total = matching.len();
        let page: Vec<Value> = matching.into_iter().skip(start_at).take(page_size).collect();
        Ok(json!({ "issues": page, "total": total, "hasMore": start_at + page_size < total }))
    }

    pub fn get_filter_metadata(&self, filters: &Value) -> Result<Value> {
        let mut relaxed = filters.clone();
        relaxed["statuses"] = json!([]);
        relaxed["issueTypes"] = json!([]);
        let page = self.get_issues(&relaxed, 0, 200)?;
        let issues = page["issues"].as_array().cloned().unwrap_or_default();
        let statuses = unique_sorted(DEMO_BOARD_STATUS_ORDER.iter().map(|status| (*status).to_owned()).chain(issues.iter().map(|issue| s(issue, "status").to_owned())));
        let types = unique_sorted(issues.iter().map(|issue| s(issue, "issueType").to_owned()));
        Ok(json!({ "statuses": statuses, "issueTypes": types }))
    }

    pub fn get_parent_items(&self, filters: &Value, search_text: Option<&str>, child_issue_type: Option<&str>) -> Result<Vec<Value>> {
        let allowed: Vec<String> = match child_issue_type {
            Some(kind) => get_parent_rule(Some(kind), BackendMode::Demo).allowed_parent_types,
            None => vec!["Feature".into(), "Epic".into()],
        };
        if allowed.is_empty() {
            return Ok(Vec::new());
        }
        let query = search_text.map(|text| text.trim().to_lowercase()).filter(|text| !text.is_empty());
        let state = self.lock()?;
        let by_key: HashMap<String, &Value> = state.issues.iter().map(|issue| (s(issue, "key").to_owned(), issue)).collect();
        let mut found: Vec<Value> = state
            .issues
            .iter()
            .filter(|issue| allowed.iter().any(|kind| kind.eq_ignore_ascii_case(s(issue, "issueType"))))
            .filter(|issue| {
                let wanted = strings(filters, "projectKeys");
                wanted.is_empty() || wanted.iter().any(|key| key == s(issue, "projectKey"))
            })
            .filter(|issue| {
                let wanted = strings(filters, "statuses");
                wanted.is_empty() || wanted.iter().any(|status| status == s(issue, "status"))
            })
            .filter(|issue| {
                query.as_ref().is_none_or(|query| {
                    format!("{} {} {}", s(issue, "key"), s(issue, "summary"), s(issue, "description")).to_lowercase().contains(query)
                })
            })
            .map(|issue| issue_summary(issue, Some(&by_key)))
            .collect();
        sort_issues_by_updated(&mut found);
        Ok(found)
    }

    pub fn get_boards(&self, filters: &Value) -> Result<Vec<Value>> {
        let query = s(filters, "searchText").trim().to_lowercase();
        let projects = strings(filters, "projectKeys");
        let types = strings(filters, "types");
        let state = self.lock()?;
        let mut boards: Vec<Value> = state
            .boards
            .iter()
            .filter(|board| projects.is_empty() || projects.iter().any(|key| key == s(board, "projectKey")))
            .filter(|board| types.is_empty() || types.iter().any(|kind| kind == s(board, "type")))
            .filter(|board| {
                query.is_empty()
                    || format!("{} {} {} {}", s(board, "name"), s(board, "projectKey"), s(board, "projectName"), s(board, "locationName"))
                        .to_lowercase()
                        .contains(&query)
            })
            .map(board_view)
            .collect();
        boards.sort_by(|a, b| ci_cmp(s(a, "name"), s(b, "name")));
        Ok(boards)
    }

    pub fn get_board_details(&self, board: &Value) -> Result<Value> {
        let state = self.lock()?;
        let matching = state
            .boards
            .iter()
            .find(|candidate| candidate["id"] == board["id"])
            .ok_or_else(|| format!("Demo board {} was not found.", s(board, "name")))?;
        let keys = strings(matching, "issueKeys");
        let by_key: HashMap<String, &Value> = state.issues.iter().map(|issue| (s(issue, "key").to_owned(), issue)).collect();
        let mut issues: Vec<Value> =
            state.issues.iter().filter(|issue| keys.iter().any(|key| key == s(issue, "key"))).map(|issue| issue_summary(issue, Some(&by_key))).collect();
        sort_issues_by_updated(&mut issues);
        Ok(json!({
            "board": board_view(matching),
            "columns": build_board_columns(&issues, &DEMO_BOARD_STATUS_ORDER),
            "issues": issues,
            "columnStatusOrder": DEMO_BOARD_STATUS_ORDER
        }))
    }

    pub fn create_board(&self, input: &Value) -> Result<Value> {
        let name = s(input, "name").trim().to_owned();
        if name.is_empty() {
            return Err("Board name cannot be empty.".into());
        }
        let project = Self::projects().into_iter().find(|p| p["key"] == input["projectKey"]).ok_or_else(|| format!("Project {} is not available in demo mode.", s(input, "projectKey")))?;
        let mut state = self.lock()?;
        let board = json!({
            "id": format!("demo-board-{}-{}", state.boards.len() + 1, Utc::now().timestamp_millis()),
            "name": name, "type": "scrum", "createdBy": DEMO_CURRENT_USER, "createdAt": now(),
            "projectKey": project["key"], "projectName": project["name"], "locationName": project["name"], "issueKeys": []
        });
        state.boards.push(board.clone());
        Ok(board_view(&board))
    }

    pub fn update_board(&self, board_id: &str, input: &Value) -> Result<Value> {
        let mut state = self.lock()?;
        let board = state.boards.iter_mut().find(|candidate| candidate["id"] == board_id).ok_or_else(|| format!("Demo board {board_id} was not found."))?;
        if let Some(name) = input["name"].as_str() {
            let name = name.trim();
            if name.is_empty() {
                return Err("Board name cannot be empty.".into());
            }
            board["name"] = json!(name);
        }
        Ok(board_view(board))
    }

    pub fn delete_board(&self, board_id: &str) -> Result<()> {
        let mut state = self.lock()?;
        let index = state.boards.iter().position(|candidate| candidate["id"] == board_id).ok_or_else(|| format!("Demo board {board_id} was not found."))?;
        state.boards.remove(index);
        Ok(())
    }

    fn find<'a>(state: &'a State, key: &str) -> Result<&'a Value> {
        state.issues.iter().find(|candidate| candidate["key"] == key).ok_or_else(|| format!("Issue {key} was not found in demo mode."))
    }

    fn details_of(state: &State, issue: &Value) -> Value {
        let parent = issue["parent"].as_str().and_then(|key| state.issues.iter().find(|candidate| candidate["key"] == key));
        issue_details(issue, parent)
    }

    pub fn get_issue(&self, key: &str) -> Result<Value> {
        let state = self.lock()?;
        let issue = Self::find(&state, key)?;
        Ok(Self::details_of(&state, issue))
    }

    fn validate_parent(state: &State, project_key: &str, issue_type: &str, parent_key: Option<&str>, current: Option<&str>) -> Result<()> {
        let rule = get_parent_rule(Some(issue_type), BackendMode::Demo);
        let label = normalize_issue_type_label(Some(issue_type));
        if !rule.can_have_parent {
            return match parent_key {
                Some(_) => Err(format!("{label} items cannot have a parent.")),
                None => Ok(()),
            };
        }
        let Some(parent_key) = parent_key else {
            return if rule.requires_parent { Err(format!("{} is required for {label} items.", rule.default_label)) } else { Ok(()) };
        };
        if current == Some(parent_key) {
            return Err("An item cannot be its own parent.".into());
        }
        let parent = Self::find(state, parent_key)?;
        if s(parent, "projectKey") != project_key {
            return Err(format!("{} {parent_key} must be in the same project.", rule.default_label));
        }
        if !is_allowed_parent_type(Some(s(parent, "issueType")), Some(issue_type), BackendMode::Demo) {
            return Err(build_parent_validation_message(Some(issue_type), BackendMode::Demo, Some(s(parent, "issueType"))));
        }
        Ok(())
    }

    fn next_key(state: &State, project_key: &str) -> String {
        let prefix = format!("{project_key}-");
        let max = state
            .issues
            .iter()
            .filter_map(|issue| s(issue, "key").strip_prefix(&prefix).and_then(|rest| rest.parse::<u64>().ok()))
            .max()
            .unwrap_or(0);
        format!("{prefix}{}", max + 1)
    }

    fn attach_to_board(state: &mut State, key: &str, project_key: &str, preferred: Option<&str>) {
        let position = preferred
            .and_then(|id| state.boards.iter().position(|board| board["id"] == id))
            .or_else(|| state.boards.iter().position(|board| s(board, "projectKey") == project_key && !s(board, "name").to_lowercase().contains("overview")))
            .or_else(|| state.boards.iter().position(|board| s(board, "projectKey") == project_key));
        if let Some(index) = position
            && let Some(keys) = state.boards[index]["issueKeys"].as_array_mut()
        {
            keys.push(json!(key));
        }
    }

    pub fn create_issue(&self, input: &Value) -> Result<Value> {
        let project = Self::projects().into_iter().find(|p| p["key"] == input["projectKey"]).ok_or_else(|| format!("Project {} is not available in demo mode.", s(input, "projectKey")))?;
        let parent_key = input["parentKey"].as_str().map(str::trim).filter(|key| !key.is_empty());
        let mut state = self.lock()?;
        Self::validate_parent(&state, s(&project, "key"), s(input, "issueType"), parent_key, None)?;
        let stamp = now();
        let key = Self::next_key(&state, s(input, "projectKey"));
        let mut issue = json!({
            "id": format!("demo-{}", state.issues.len() + 1), "key": key, "summary": s(input, "summary").trim(),
            "status": DEMO_BOARD_STATUS_ORDER[0], "issueType": s(input, "issueType").trim(),
            "projectKey": project["key"], "projectName": project["name"], "assigneeKind": "me",
            "assigneeDisplayName": DEMO_CURRENT_USER, "priority": "Medium", "created": stamp, "updated": stamp,
            "description": s(input, "description").trim(), "comments": []
        });
        if let Some(parent) = parent_key {
            issue["parent"] = json!(parent);
        }
        state.issues.insert(0, issue.clone());
        Self::attach_to_board(&mut state, &key, s(&issue, "projectKey"), input["boardId"].as_str());
        Ok(Self::details_of(&state, &issue))
    }

    pub fn update_issue(&self, key: &str, input: &Value) -> Result<Value> {
        let mut state = self.lock()?;
        let current = Self::find(&state, key)?.clone();
        let next_type = input["issueType"].as_str().map(str::trim).filter(|kind| !kind.is_empty()).unwrap_or(s(&current, "issueType")).to_owned();
        let has = |field: &str| input.get(field).is_some();
        let next_parent: Option<String> = if has("parentKey") {
            input["parentKey"].as_str().map(str::trim).filter(|p| !p.is_empty()).map(str::to_owned)
        } else {
            current["parent"].as_str().map(str::to_owned)
        };
        Self::validate_parent(&state, s(&current, "projectKey"), &next_type, next_parent.as_deref(), Some(key))?;

        let mut issue = current;
        if let Some(summary) = input["summary"].as_str() {
            let summary = summary.trim();
            if summary.is_empty() {
                return Err("Summary cannot be empty.".into());
            }
            issue["summary"] = json!(summary);
        }
        if let Some(description) = input["description"].as_str() {
            issue["description"] = json!(description);
        }
        if has("parentKey") {
            match &next_parent {
                Some(parent) => issue["parent"] = json!(parent),
                None => {
                    issue.as_object_mut().map(|object| object.remove("parent"));
                }
            }
        }
        if has("assignee") {
            match input["assignee"].as_str().map(str::trim).filter(|a| !a.is_empty()) {
                Some(assignee) => {
                    issue["assigneeKind"] = json!(if assignee == DEMO_CURRENT_USER { "me" } else { "other" });
                    issue["assigneeDisplayName"] = json!(assignee);
                }
                None => {
                    issue["assigneeKind"] = json!("none");
                    issue.as_object_mut().map(|object| object.remove("assigneeDisplayName"));
                }
            }
        }
        if let Some(priority) = input["priority"].as_str() {
            let priority = priority.trim();
            if priority.is_empty() {
                return Err("Priority cannot be empty.".into());
            }
            issue["priority"] = json!(priority);
        }
        if let Some(kind) = input["issueType"].as_str() {
            let kind = kind.trim();
            if kind.is_empty() {
                return Err("Issue type cannot be empty.".into());
            }
            issue["issueType"] = json!(kind);
        }
        issue["updated"] = json!(now());
        let index = state.issues.iter().position(|candidate| candidate["key"] == key).ok_or("Issue vanished.")?;
        state.issues[index] = issue.clone();
        Ok(Self::details_of(&state, &issue))
    }

    pub fn delete_issue(&self, key: &str) -> Result<()> {
        let mut state = self.lock()?;
        let index = state.issues.iter().position(|candidate| candidate["key"] == key).ok_or_else(|| format!("Issue {key} was not found in demo mode."))?;
        state.issues.remove(index);
        let stamp = now();
        for issue in &mut state.issues {
            if issue["parent"] == key {
                issue.as_object_mut().map(|object| object.remove("parent"));
                issue["updated"] = json!(stamp);
            }
        }
        for board in &mut state.boards {
            if let Some(keys) = board["issueKeys"].as_array_mut() {
                keys.retain(|candidate| candidate != key);
            }
        }
        Ok(())
    }

    pub fn add_comment(&self, key: &str, body: &str) -> Result<()> {
        let mut state = self.lock()?;
        let body = body.trim();
        let index = state.issues.iter().position(|candidate| candidate["key"] == key).ok_or_else(|| format!("Issue {key} was not found in demo mode."))?;
        if body.is_empty() {
            return Err("Comment cannot be empty.".into());
        }
        let stamp = now();
        let issue = &mut state.issues[index];
        let count = issue["comments"].as_array().map_or(0, Vec::len);
        let comment = json!({ "id": format!("demo-comment-{key}-{}", count + 1), "author": DEMO_CURRENT_USER, "body": body, "created": stamp, "updated": stamp });
        if let Some(comments) = issue["comments"].as_array_mut() {
            comments.insert(0, comment);
        }
        issue["updated"] = json!(stamp);
        Ok(())
    }

    pub fn get_transitions(&self, key: &str) -> Result<Vec<Value>> {
        let state = self.lock()?;
        Ok(transition_set(s(Self::find(&state, key)?, "status")))
    }

    pub fn transition_issue(&self, key: &str, transition_id: &str) -> Result<()> {
        let mut state = self.lock()?;
        let index = state.issues.iter().position(|candidate| candidate["key"] == key).ok_or_else(|| format!("Issue {key} was not found in demo mode."))?;
        let issue = &mut state.issues[index];
        let transition = transition_set(s(issue, "status")).into_iter().find(|candidate| candidate["id"] == transition_id).ok_or_else(|| format!("Transition {transition_id} is not valid for {key}."))?;
        if issue["failTransition"] == true {
            return Err(format!("Workflow rejected the transition for {key} because extra fields are required."));
        }
        if let Some(target) = transition["toStatus"].as_str() {
            issue["status"] = json!(target);
        }
        issue["updated"] = json!(now());
        Ok(())
    }

    pub fn attach_file() -> Result<()> {
        Err("Attachments are not supported in Demo mode.".into())
    }

    pub fn download_attachment() -> Result<()> {
        Err("Attachment downloads are not supported in Demo mode.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn filters() -> Value {
        json!({ "projectKeys": [], "statuses": [], "issueTypes": [], "assigneeMode": "all", "searchText": "" })
    }

    #[test]
    fn seeds_the_documented_boards_and_pages_issues() {
        let demo = DemoService::default();
        let boards = demo.get_boards(&json!({ "projectKeys": [], "types": [], "searchText": "" })).expect("boards");
        let names: Vec<&str> = boards.iter().map(|b| s(b, "name")).collect();
        assert_eq!(names, vec!["Application Board", "Operations Board", "Platform Overview"]);
        let page = demo.get_issues(&filters(), 0, 25).expect("issues");
        assert_eq!(page["total"], 35);
        assert_eq!(page["issues"].as_array().map(Vec::len), Some(25));
        assert_eq!(page["hasMore"], true);
        assert_eq!(page["issues"][0]["key"], "OPS-200", "most recently updated first");
        let second = demo.get_issues(&filters(), 25, 25).expect("second page");
        assert_eq!(second["hasMore"], false);
    }

    #[test]
    fn board_details_emit_every_workflow_column_even_when_empty() {
        let demo = DemoService::default();
        let boards = demo.get_boards(&json!({})).expect("boards");
        let ops = boards.iter().find(|b| b["id"] == "board-ops").expect("ops");
        let details = demo.get_board_details(ops).expect("details");
        let names: Vec<&str> = details["columns"].as_array().expect("columns").iter().map(|c| s(c, "name")).collect();
        assert_eq!(names, DEMO_BOARD_STATUS_ORDER);
        assert_eq!(details["columns"][1]["issues"][0]["key"], "OPS-200");
        assert_eq!(details["columns"][0]["issues"].as_array().map(Vec::len), Some(0));
    }

    #[test]
    fn transitions_comments_and_the_rejected_transition_behave_like_the_original() {
        let demo = DemoService::default();
        demo.transition_issue("APP-101", "start-progress").expect("valid");
        assert_eq!(demo.get_issue("APP-101").expect("issue")["status"], "In Progress");
        assert!(demo.transition_issue("APP-101", "resume").unwrap_err().contains("not valid"));
        assert!(demo.transition_issue("APP-103", "resume").unwrap_err().contains("extra fields are required"));
        demo.add_comment("OPS-200", "  hello ").expect("comment");
        assert_eq!(demo.get_issue("OPS-200").expect("issue")["comments"][0]["body"], "hello");
        assert_eq!(demo.add_comment("OPS-200", "  ").unwrap_err(), "Comment cannot be empty.");
    }

    #[test]
    fn create_update_and_delete_keep_boards_and_parents_consistent() {
        let demo = DemoService::default();
        let created = demo.create_issue(&json!({ "projectKey": "APP", "issueType": "Task", "summary": " New thing ", "parentKey": "APP-100" })).expect("create");
        assert_eq!((s(&created, "key"), s(&created, "status"), s(&created, "summary")), ("APP-231", "Backlog", "New thing"));
        let board = demo.get_boards(&json!({})).expect("boards").into_iter().find(|b| b["id"] == "board-app").expect("app");
        let on_board = demo.get_board_details(&board).expect("details")["issues"].as_array().expect("issues").iter().any(|i| i["key"] == "APP-231");
        assert!(on_board, "new issues land on the project's non-overview board");
        assert!(demo.create_issue(&json!({ "projectKey": "APP", "issueType": "Task", "summary": "x", "parentKey": "OPS-200" })).is_err(), "parents must be a Feature/Epic");
        demo.update_issue("APP-231", &json!({ "summary": "Renamed", "assignee": "" })).expect("update");
        let updated = demo.get_issue("APP-231").expect("issue");
        assert_eq!(updated["summary"], "Renamed");
        assert!(updated.get("assignee").is_none());
        demo.delete_issue("APP-100").expect("delete parent");
        assert!(demo.get_issue("APP-101").expect("child")["parentKey"].is_null(), "children are orphaned, not deleted");
        assert!(demo.get_issue("APP-100").is_err());
    }

    #[test]
    fn filters_and_metadata_match_the_original() {
        let demo = DemoService::default();
        let mine = demo.get_issues(&json!({ "projectKeys": ["APP"], "assigneeMode": "me", "searchText": "" }), 0, 100).expect("mine");
        assert!(mine["issues"].as_array().expect("issues").iter().all(|i| i["assignee"] == DEMO_CURRENT_USER));
        let overview = demo.get_issues(&json!({ "boardId": "board-overview" }), 0, 100).expect("overview");
        assert_eq!(overview["total"], 1);
        let meta = demo.get_filter_metadata(&filters()).expect("meta");
        assert_eq!(meta["statuses"], json!(["Backlog", "Blocked", "Done", "In Progress", "To Do"]));
        let parents = demo.get_parent_items(&json!({ "projectKeys": ["APP"], "statuses": [] }), None, None).expect("parents");
        assert_eq!(parents.iter().map(|p| s(p, "key")).collect::<Vec<_>>(), vec!["APP-100"]);
    }
}
