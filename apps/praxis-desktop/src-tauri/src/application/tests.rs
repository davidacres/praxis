use super::*;
use std::fs;
use std::path::PathBuf;

use praxis_contracts::RustRpcRequest;
use praxis_host::HostConfig;
use uuid::Uuid;

struct Profile {
    root: PathBuf,
    host: HostContext,
}
impl Profile {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("praxis-tauri-application-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("profile");
        let host = Self::open(&root);
        Self { root, host }
    }
    fn open(root: &std::path::Path) -> HostContext {
        let host =
            HostContext::new(HostConfig::for_user_data_dir(root, false, true).expect("config"));
        Application::register(&host, "0.1.0-test");
        host
    }
    fn rpc(&self, channel: &str, args: Vec<Value>) -> Value {
        invoke(&self.host, channel, args).expect("RPC")
    }
    fn try_rpc(&self, channel: &str, args: Vec<Value>) -> Result<Value> {
        invoke(&self.host, channel, args)
    }
}
impl Drop for Profile {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).expect("cleanup profile");
    }
}

fn invoke(host: &HostContext, channel: &str, args: Vec<Value>) -> Result<Value> {
    let response = host.dispatch_rpc(RustRpcRequest {
        id: Uuid::new_v4().to_string(),
        channel: channel.into(),
        args,
    });
    if response.ok {
        Ok(response.result.unwrap_or(Value::Null))
    } else {
        Err(response.error.expect("error"))
    }
}

fn project_input(folder: &std::path::Path) -> Value {
    json!({"name": "Source project", "key": "SOURCE", "type": "software", "purpose": "Read files", "brief": {},
        "startingPoint": "existing-folder", "folderPath": folder, "planningMode": "files", "storage": "app",
        "workflowStages": [{"id":"todo","name":"Planned","category":"todo"},{"id":"done","name":"Delivered","category":"done"}],
        "starterTickets": [], "defaultAiToolMode": "full"})
}

#[test]
fn workspace_and_project_survive_reopen_with_categories_and_owned_files() {
    let profile = Profile::new();
    let folder = profile.root.join("checkout");
    fs::create_dir(&folder).expect("checkout");
    let workspace = profile.rpc("workspaces:openFolder", vec![json!(folder)]);
    let project = profile.rpc(
        "projects:create",
        vec![project_input(&folder), workspace["id"].clone()],
    );
    assert_eq!(project["workflowStages"][1]["category"], "done");
    assert_eq!(project["folderInspection"]["projectFileExists"], true);
    assert!(
        folder
            .join(praxis_core::projects::PROJECT_FILE_NAME)
            .is_file()
    );
    let filename = folder.join(praxis_core::workspaces::workspace_file_name("checkout"));
    let bytes = fs::read_to_string(&filename).expect("workspace file");
    let stored: Value = serde_json::from_str(&bytes).expect("portable document");
    assert_eq!(stored["projects"][0]["workspaceFolder"], ".");
    assert!(!bytes.contains("folderInspection"));
    let reopened = Profile::open(&profile.root);
    let saved =
        invoke(&reopened, "projects:get", vec![project["id"].clone()]).expect("saved project");
    assert_eq!(
        saved["workspaceFolder"],
        json!(fs::canonicalize(&folder).expect("canonical folder"))
    );
    let workspace = invoke(&reopened, "workspaces:get", vec![workspace["id"].clone()])
        .expect("saved workspace");
    assert_eq!(workspace["projectIds"], json!([project["id"]]));
    profile.rpc("workspaces:remove", vec![workspace["id"].clone()]);
    assert_eq!(
        fs::read_to_string(filename).expect("user file retained"),
        bytes
    );
    assert_eq!(profile.rpc("workspaces:list", vec![]), json!([]));
}

#[test]
fn malformed_metadata_is_reported_and_never_replaced() {
    let profile = Profile::new();
    let file = profile.root.join("workspaces.json");
    fs::write(&file, "{ broken").expect("corrupt fixture");
    assert!(
        invoke(
            &profile.host,
            "workspaces:create",
            vec![json!({"name":"New"})]
        )
        .is_err()
    );
    assert_eq!(fs::read_to_string(file).expect("preserved"), "{ broken");
    let settings = profile.root.join("settings.json");
    fs::write(&settings, "{ broken settings").expect("corrupt settings fixture");
    assert!(
        invoke(
            &profile.host,
            "settings:set",
            vec![json!({"appearance": {"themeId":"praxis-dark"}})]
        )
        .is_err()
    );
    assert_eq!(
        fs::read_to_string(settings).expect("settings preserved"),
        "{ broken settings"
    );
}

#[test]
fn project_creation_requires_valid_workspace_and_keeps_markerless_project_file() {
    let profile = Profile::new();
    let folder = profile.root.join("checkout");
    fs::create_dir(&folder).expect("checkout");
    let file = folder.join(praxis_core::projects::PROJECT_FILE_NAME);
    fs::write(&file, "# This belongs to the person\n").expect("user file");
    assert!(
        invoke(
            &profile.host,
            "projects:create",
            vec![project_input(&folder), json!("missing")]
        )
        .is_err()
    );
    assert!(!profile.root.join("projects.json").exists());
    let workspace = profile.rpc("workspaces:create", vec![json!({"name":"Local"})]);
    let project = profile.rpc(
        "projects:create",
        vec![project_input(&folder), workspace["id"].clone()],
    );
    assert_eq!(project["projectFileStatus"], "retained");
    assert_eq!(
        fs::read_to_string(file).expect("preserved"),
        "# This belongs to the person\n"
    );
    assert!(
        invoke(
            &profile.host,
            "projects:create",
            vec![project_input(&folder), workspace["id"].clone()]
        )
        .is_err()
    );
}

#[test]
fn competing_profile_writer_cannot_mutate_metadata_or_settings() {
    let profile = Profile::new();
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(profile.root.join("desktop-state.praxis.lock"))
        .expect("lock file");
    lock.try_lock().expect("competing writer owns lock");
    assert!(
        invoke(
            &profile.host,
            "workspaces:create",
            vec![json!({"name": "Must not save"})]
        )
        .is_err()
    );
    assert!(
        invoke(
            &profile.host,
            "settings:set",
            vec![json!({"appearance": {"themeId": "praxis-dark"}})]
        )
        .is_err()
    );
    assert!(!profile.root.join("workspaces.json").exists());
    assert!(!profile.root.join("settings.json").exists());
    drop(lock);
    profile.rpc(
        "workspaces:create",
        vec![json!({"name": "After lock released"})],
    );
}

fn product_input(key: &str) -> Value {
    let mut input = project_input(std::path::Path::new("unused"));
    input["type"] = json!("product");
    input["name"] = json!(format!("{key} product"));
    input["key"] = json!(key);
    input["startingPoint"] = json!("app-storage");
    input["planningMode"] = json!("board");
    input["workflowStages"][1]["name"] = json!("Done");
    input["starterTickets"] = json!([
        {"summary":"Feature", "description":"Scope", "issueType":"Feature", "status":"Planned"},
        {"summary":"Story", "description":"A story", "issueType":"Story", "status":"Planned"}
    ]);
    input
}

#[test]
fn local_board_issue_lifecycle_preserves_parent_rules_filters_and_keys_after_rename() {
    let profile = Profile::new();
    let workspace = profile.rpc("workspaces:create", vec![json!({"name":"Product work"})]);
    let project = profile.rpc(
        "projects:create",
        vec![product_input("APP"), workspace["id"].clone()],
    );
    assert_eq!(project["defaultAiToolMode"], "project-only");
    let id = json!(format!(
        "project:{}",
        project["id"].as_str().expect("project id")
    ));
    let boards = profile.rpc("board:list", vec![json!({}), id.clone()]);
    assert_eq!(boards.as_array().expect("boards").len(), 1);
    assert_eq!(
        profile.rpc("board:get", vec![boards[0].clone()])["issues"]
            .as_array()
            .expect("issues")
            .len(),
        2
    );
    assert!(
        invoke(
            &profile.host,
            "issue:create",
            vec![
                json!({"projectKey":"APP","summary":"Invalid subtask","issueType":"Subtask"}),
                id.clone()
            ]
        )
        .is_err()
    );
    let item = profile.rpc("issue:create", vec![json!({"projectKey":"APP","summary":"Child task","issueType":"Task","parentKey":"APP-1","origin":"capture"}), id.clone()]);
    assert_eq!(item["key"], "APP-3");
    assert_eq!(item["parentIssue"]["issueType"], "Feature");
    profile.rpc(
        "issue:update",
        vec![
            json!("APP-3"),
            json!({"summary":"Changed child", "parentKey":null}),
            id.clone(),
        ],
    );
    assert!(
        invoke(
            &profile.host,
            "issue:transition",
            vec![json!("APP-3"), json!("not-a-stage"), id.clone()]
        )
        .is_err()
    );
    profile.rpc(
        "issue:transition",
        vec![json!("APP-3"), json!("done"), id.clone()],
    );
    let page = profile.rpc(
        "issue:list",
        vec![
            json!({"statuses":["Done"], "searchText":"Changed"}),
            json!(0),
            json!(10),
            id.clone(),
        ],
    );
    assert_eq!(page["total"], 1);
    assert_eq!(page["issues"][0]["origin"], "capture");
    profile.rpc(
        "projects:update",
        vec![project["id"].clone(), json!({"key":"renamed"})],
    );
    let item = profile.rpc("issue:get", vec![json!("APP-3"), id.clone()]);
    assert_eq!(item["projectKey"], "RENAMED");
    assert_eq!(item["key"], "APP-3");
    assert!(
        invoke(
            &profile.host,
            "issue:addComment",
            vec![json!("APP-3"), json!("No pretend comments"), id.clone()]
        )
        .is_err()
    );
    profile.rpc("issue:delete", vec![json!("APP-3"), id]);
}

#[test]
fn running_ticket_workflow_blocks_completion_without_mutating_the_ticket() {
    let profile = Profile::new();
    let workspace = profile.rpc("workspaces:create", vec![json!({"name":"Work"})]);
    let project = profile.rpc(
        "projects:create",
        vec![product_input("GATE"), workspace["id"].clone()],
    );
    let id = json!(format!(
        "project:{}",
        project["id"].as_str().expect("project id")
    ));
    fs::write(profile.root.join("workflows.json"), json!({"praxis.workflowRuns.v1":[{"issueKey":"GATE-1", "status":"running", "definition":{"trigger":"ticket","name":"Delivery"}}]}).to_string()).expect("workflow fixture");
    assert!(
        invoke(
            &profile.host,
            "issue:transition",
            vec![json!("GATE-1"), json!("done"), id.clone()]
        )
        .is_err()
    );
    assert_eq!(
        profile.rpc("issue:get", vec![json!("GATE-1"), id.clone()])["status"],
        "Planned"
    );
    fs::write(profile.root.join("workflows.json"), json!({"praxis.workflowRuns.v1":[{"issueKey":"GATE-1", "status":"succeeded", "definition":{"trigger":"ticket","name":"Delivery"}}]}).to_string()).expect("workflow succeeded");
    profile.rpc("issue:transition", vec![json!("GATE-1"), json!("done"), id]);
}

#[test]
fn portable_export_strips_secrets_and_resolves_paths_after_moving_the_tree() {
    let profile = Profile::new();
    let tree = profile.root.join("tree");
    let checkout = tree.join("checkout");
    fs::create_dir_all(&checkout).expect("checkout");
    let workspace = profile.rpc("workspaces:create", vec![json!({"name":"Portable"})]);
    let project = profile.rpc(
        "projects:create",
        vec![project_input(&checkout), workspace["id"].clone()],
    );
    profile.rpc("connection:add", vec![json!({"id":"folder","name":"Folder","mode":"folder","settings":{"roots":[checkout],"apiKey":"fixture-do-not-copy","password":"fixture-private"}})]);
    profile.rpc(
        "workspaces:update",
        vec![workspace["id"].clone(), json!({"connectionIds":["folder"]})],
    );
    let path = tree.join(praxis_core::workspaces::workspace_file_name("Portable"));
    profile.rpc(
        "workspaces:writeFile",
        vec![workspace["id"].clone(), json!(path)],
    );
    let raw = fs::read_to_string(&path).expect("export");
    assert!(!raw.contains("fixture-do-not-copy"));
    assert!(!raw.contains("fixture-private"));
    assert!(!raw.contains("folderInspection"));
    let document: Value = serde_json::from_str(&raw).expect("document");
    assert_eq!(document["projects"][0]["workspaceFolder"], "./checkout");
    assert_eq!(
        document["connections"][0]["settings"]["roots"][0],
        "./checkout"
    );
    let moved = profile.root.join("moved");
    fs::rename(&tree, &moved).expect("move fixture tree");
    profile.rpc(
        "workspaces:openFile",
        vec![json!(moved.join(
            praxis_core::workspaces::workspace_file_name("Portable")
        ))],
    );
    let restored = profile.rpc("projects:get", vec![project["id"].clone()]);
    assert_eq!(
        restored["workspaceFolder"],
        json!(fs::canonicalize(moved.join("checkout")).expect("canonical checkout"))
    );
}

#[test]
fn editing_one_workspace_does_not_rewrite_an_unrelated_workspace_file() {
    let profile = Profile::new();
    let a = profile.root.join("a");
    let b = profile.root.join("b");
    let first = profile.rpc(
        "workspaces:create",
        vec![json!({"name":"A", "storageFolder":a})],
    );
    let other = profile.rpc(
        "workspaces:create",
        vec![json!({"name":"B", "storageFolder":b})],
    );
    let path = PathBuf::from(other["storagePath"].as_str().expect("path"));
    let original = format!("{}\n\n", fs::read_to_string(&path).expect("document"));
    fs::write(&path, &original).expect("retain person's formatting");
    profile.rpc(
        "workspaces:update",
        vec![first["id"].clone(), json!({"description":"Changed A"})],
    );
    assert_eq!(fs::read_to_string(path).expect("unrelated file"), original);
}

#[test]
fn project_removal_updates_all_workspace_references_and_retains_user_files() {
    let profile = Profile::new();
    let checkout = profile.root.join("checkout");
    fs::create_dir(&checkout).expect("checkout");
    let first = profile.rpc("workspaces:create", vec![json!({"name":"One"})]);
    let project = profile.rpc(
        "projects:create",
        vec![project_input(&checkout), first["id"].clone()],
    );
    let second = profile.rpc(
        "workspaces:create",
        vec![json!({"name":"Two", "storageFolder":profile.root.join("portable")})],
    );
    profile.rpc(
        "projects:useExisting",
        vec![project["id"].clone(), second["id"].clone()],
    );
    let descriptor = checkout.join(praxis_core::projects::PROJECT_FILE_NAME);
    let bytes = fs::read(&descriptor).expect("descriptor");
    profile.rpc("projects:remove", vec![project["id"].clone()]);
    assert_eq!(profile.rpc("projects:list", vec![]), json!([]));
    for workspace in [first, second] {
        let saved = profile.rpc("workspaces:get", vec![workspace["id"].clone()]);
        assert_eq!(saved["projectIds"], json!([]));
        assert!(saved.get("defaultProjectId").is_none());
    }
    assert_eq!(fs::read(descriptor).expect("retained descriptor"), bytes);
}

#[test]
fn connections_and_settings_share_serialized_writes_without_lost_keys() {
    let profile = Profile::new();
    std::thread::scope(|scope| {
        for index in 0..12 {
            let host = &profile.host;
            scope.spawn(move || {
                invoke(host, "connection:add", vec![json!({"id":format!("folder-{index}"),"name":"Folder","mode":"folder","settings":{"roots":[]}})]).expect("connection write");
                invoke(host, "settings:set", vec![json!({"appearance":{"themeId":"praxis-dark"}})]).expect("settings write");
            });
        }
    });
    assert_eq!(
        profile
            .rpc("connection:list", vec![])
            .as_array()
            .expect("connections")
            .len(),
        12
    );
    assert_eq!(
        profile.rpc("settings:get", vec![])["appearance"]["themeId"],
        "praxis-dark"
    );
    profile.rpc(
        "connection:addTrackedBoards",
        vec![json!([{"connectionId":"folder-0","boardId":"board"}])],
    );
    assert!(invoke(&profile.host, "connection:remove", vec![json!("folder-0")]).is_err());
    assert!(
        invoke(
            &profile.host,
            "connection:update",
            vec![json!({"id":"folder-0","name":"Wrong mode","mode":"app","settings":{}})]
        )
        .is_err()
    );
    profile.rpc(
        "connection:removeTrackedBoard",
        vec![json!("folder-0"), json!("board")],
    );
    profile.rpc("connection:remove", vec![json!("folder-0")]);
}

#[cfg(unix)]
#[test]
fn project_document_reader_rejects_traversal_and_symlink_escapes() {
    let profile = Profile::new();
    let checkout = profile.root.join("checkout");
    let plans = checkout.join("docs/plans");
    fs::create_dir_all(&plans).expect("plans");
    fs::write(
        plans.join("task.md"),
        "---\ntype: Task\nstatus: In Progress\n---\n# A task\n",
    )
    .expect("task");
    let outside = profile.root.join("private.md");
    fs::write(&outside, "private").expect("outside file");
    std::os::unix::fs::symlink(&outside, plans.join("escape.md")).expect("symlink");
    let workspace = profile.rpc("workspaces:create", vec![json!({"name":"Documents"})]);
    let project = profile.rpc(
        "projects:create",
        vec![project_input(&checkout), workspace["id"].clone()],
    );
    let read = profile.rpc(
        "projects:readDocument",
        vec![project["id"].clone(), json!("task.md")],
    );
    assert_eq!(read["name"], "A task");
    assert_eq!(read["type"], "Task");
    for path in ["../../../private.md", "escape.md"] {
        assert!(
            invoke(
                &profile.host,
                "projects:readDocument",
                vec![project["id"].clone(), json!(path)]
            )
            .is_err()
        );
    }
    assert_eq!(
        profile.rpc("projects:listDocuments", vec![project["id"].clone()])["documents"]
            .as_array()
            .expect("documents")
            .len(),
        1
    );
}

#[test]
fn located_folder_connections_use_the_real_tracker_and_keep_workflow_identity() {
    let profile = Profile::new();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    praxis_host::tracker_bridge::register_tracker_channels(&profile.host, runtime.handle());
    let folder = profile.root.join("plans");
    fs::create_dir(&folder).expect("plans");
    fs::write(folder.join(praxis_core::folder::BOARD_CONFIG_FILENAME), json!({"projectKey":"PLAN", "projectName":"Plans", "allowIssueCreation":true,
        "workflow":[{"id":"todo","name":"Planned","category":"todo"},{"id":"done","name":"Delivered","category":"done"}]}).to_string()).expect("board identity");
    fs::write(folder.join("task.md"), "# PLAN-1: Existing task\n\n**Status:** Planned\n**Type:** Task\n**Priority:** Medium\n\n## Description\n\nOriginal body\n").expect("task");
    let workspace = profile.rpc("workspaces:openFolder", vec![json!(folder)]);
    profile.rpc("workspaces:setActive", vec![workspace["id"].clone()]);
    let mut connection = json!({"id":"plans", "name":"Plans", "mode":"folder", "settings":{"roots":[folder], "projectKey":"PLAN", "projectName":"Plans", "allowIssueCreation":true}});
    profile.rpc("connection:add", vec![connection.clone()]);
    assert!(
        !fs::read_to_string(profile.root.join("settings.json"))
            .unwrap_or_default()
            .contains("\"plans\"")
    );
    assert_eq!(
        profile
            .rpc("folder:discoverPlans", vec![json!("plans")])
            .as_array()
            .expect("roots")
            .len(),
        1
    );
    assert_eq!(
        profile.rpc("connection:check", vec![json!("plans")])["status"],
        "ok"
    );
    let boards = profile.rpc("board:list", vec![json!({}), json!("plans")]);
    assert_eq!(boards[0]["connectionId"], "plans");
    let details = profile.rpc("board:get", vec![boards[0].clone()]);
    assert!(
        details["issues"][0]["key"]
            .as_str()
            .expect("folder issue key")
            .starts_with("PLAN-")
    );
    let item = profile.rpc("issue:create", vec![json!({"projectKey":"PLAN", "summary":"Created in Rust", "issueType":"Feature", "description":"Stored markdown"}), json!("plans")]);
    let key = item["key"].clone();
    profile.rpc(
        "issue:update",
        vec![
            key.clone(),
            json!({"summary":"Updated in Rust"}),
            json!("plans"),
        ],
    );
    assert_eq!(
        profile.rpc("issue:get", vec![key, json!("plans")])["summary"],
        "Updated in Rust"
    );
    connection["settings"]["projectName"] = json!("Renamed plans");
    profile.rpc("connection:update", vec![connection]);
    let config = praxis_core::folder::read_board_config_file(&folder);
    assert_eq!(config.project_name.as_deref(), Some("Renamed plans"));
    assert_eq!(
        config.workflow.expect("workflow")[1].category,
        Some(praxis_contracts::WorkflowStageCategory::Done)
    );
    let reopened = Profile::open(&profile.root);
    assert_eq!(
        invoke(&reopened, "connection:list", vec![]).expect("located connection")[0]["settings"]["projectName"],
        "Renamed plans"
    );
}

#[test]
fn board_preferences_persists_across_reopen_with_defaults() {
    let profile = Profile::new();
    let initial = profile.rpc("boardPrefs:get", vec![json!("board-1")]);
    assert_eq!(
        initial["workflowStatuses"]
            .as_array()
            .expect("statuses")
            .len(),
        0
    );
    assert_eq!(
        initial["orderedStatuses"]
            .as_array()
            .expect("ordered")
            .len(),
        0
    );

    let saved = profile.rpc(
        "boardPrefs:set",
        vec![
            json!("board-1"),
            json!({
                "workflowStatuses": ["Backlog", "Done"],
                "orderedStatuses": ["Backlog", "Done"],
                "viewMode": "list"
            }),
        ],
    );
    assert_eq!(saved, Value::Null);

    let fetched = profile.rpc("boardPrefs:get", vec![json!("board-1")]);
    assert_eq!(fetched["viewMode"], "list");
    assert_eq!(fetched["workflowStatuses"][0], "Backlog");

    let reopened = Profile::open(&profile.root);
    let after_reopen = invoke(&reopened, "boardPrefs:get", vec![json!("board-1")]).expect("get");
    assert_eq!(after_reopen["viewMode"], "list");
    assert_eq!(after_reopen["workflowStatuses"][1], "Done");
}

#[test]
fn log_bus_buffers_recent_lines_and_persists() {
    let profile = Profile::new();
    let logs_dir = profile.root.join("logs");
    fs::create_dir_all(&logs_dir).expect("logs dir");
    let log_file = logs_dir.join("application.log");
    fs::write(
        &log_file,
        format!(
            "{}\n{}\n",
            serde_json::to_string("first log").expect("json"),
            serde_json::to_string("second log").expect("json")
        ),
    )
    .expect("write log");

    let reopened = Profile::open(&profile.root);
    let recent = invoke(&reopened, "log:getRecent", vec![]).expect("getRecent");
    let arr = recent.as_array().expect("array");
    assert_eq!(arr.len(), 2);
    assert_eq!(arr[0], "first log");
    assert_eq!(arr[1], "second log");
}

#[test]
fn activity_list_aggregates_stored_entries() {
    let profile = Profile::new();
    let folder = profile.root.join("checkout");
    fs::create_dir_all(&folder).expect("checkout");
    let workspace = profile.rpc("workspaces:openFolder", vec![json!(folder)]);
    let project = profile.rpc(
        "projects:create",
        vec![project_input(&folder), workspace["id"].clone()],
    );
    let project_id = project["id"].as_str().expect("project id");

    let act_file = profile.root.join("project-activity.json");
    let now_ts = Utc::now().to_rfc3339();
    let initial_data = json!({
        format!("activity:{project_id}"): {
            "startedAt": now_ts,
            "entries": [{
                "id": "entry-1",
                "projectId": project_id,
                "kind": "issue",
                "targetKey": "KEY-1",
                "summary": "First ticket",
                "action": "Created",
                "timestamp": now_ts
            }]
        }
    });
    fs::write(
        &act_file,
        serde_json::to_string(&initial_data).expect("json"),
    )
    .expect("write act");

    let res = profile.rpc("activity:list", vec![json!(project_id)]);
    assert_eq!(res["entries"].as_array().expect("entries").len(), 1);
    assert_eq!(res["entries"][0]["summary"], "First ticket");
}

#[test]
fn notes_crud_and_snapshot_lifecycle() {
    let profile = Profile::new();
    let folder = profile.root.join("checkout");
    fs::create_dir_all(&folder).expect("checkout");
    let workspace = profile.rpc("workspaces:openFolder", vec![json!(folder)]);
    let project = profile.rpc(
        "projects:create",
        vec![project_input(&folder), workspace["id"].clone()],
    );
    let project_id = project["id"].as_str().expect("project id");

    // 1. Create note
    let created_note = profile.rpc(
        "notes:createNote",
        vec![
            json!(project_id),
            json!({"title": "Design Notes", "body": "Initial architecture text"}),
        ],
    );
    assert_eq!(created_note["ok"], true);
    let note_id = created_note["value"]["id"]
        .as_str()
        .expect("note id")
        .to_string();

    // 2. Create group
    let created_group = profile.rpc(
        "notes:createGroup",
        vec![
            json!(project_id),
            json!({"title": "Sprint 1", "noteIds": [note_id.clone()]}),
        ],
    );
    assert_eq!(created_group["ok"], true);
    let group_id = created_group["value"]["id"]
        .as_str()
        .expect("group id")
        .to_string();

    // 3. List
    let list_res = profile.rpc("notes:list", vec![json!(project_id)]);
    assert_eq!(list_res["ok"], true);
    assert_eq!(
        list_res["value"]["notes"].as_array().expect("notes").len(),
        1
    );
    assert_eq!(
        list_res["value"]["groups"]
            .as_array()
            .expect("groups")
            .len(),
        1
    );

    // 4. Update note
    let updated_note = profile.rpc(
        "notes:updateNote",
        vec![
            json!(project_id),
            json!(note_id),
            json!({"title": "Design Notes (v2)", "body": "Updated text"}),
        ],
    );
    assert_eq!(updated_note["ok"], true);
    assert_eq!(updated_note["value"]["title"], "Design Notes (v2)");

    // 5. Prepare snapshot
    let snapshot = profile.rpc(
        "notes:prepareSnapshot",
        vec![json!(project_id), json!({"kind": "group", "id": group_id})],
    );
    assert_eq!(snapshot["ok"], true);
    assert_eq!(snapshot["value"]["notes"][0]["title"], "Design Notes (v2)");

    // 6. Delete group
    let deleted_group = profile.rpc(
        "notes:deleteGroup",
        vec![json!(project_id), json!(group_id)],
    );
    assert_eq!(deleted_group["ok"], true);

    // 7. Delete note
    let deleted_note = profile.rpc("notes:deleteNote", vec![json!(project_id), json!(note_id)]);
    assert_eq!(deleted_note["ok"], true);

    let empty_list = profile.rpc("notes:list", vec![json!(project_id)]);
    assert_eq!(
        empty_list["value"]["notes"]
            .as_array()
            .expect("notes")
            .len(),
        0
    );
}

#[test]
fn artifacts_list_read_and_groups_lifecycle() {
    let profile = Profile::new();
    let folder = profile.root.join("checkout");
    let artifacts_dir = folder.join("docs").join("published-artifacts");
    fs::create_dir_all(&artifacts_dir).expect("artifacts dir");
    let text_file = artifacts_dir.join("notes.md");
    fs::write(&text_file, "# Architecture doc\nHello world").expect("write md");
    let html_file = artifacts_dir.join("page.html");
    fs::write(
        &html_file,
        "<html><head><title>Visual Page</title></head><body>Content</body></html>",
    )
    .expect("write html");

    let workspace = profile.rpc("workspaces:openFolder", vec![json!(folder)]);
    let project = profile.rpc(
        "projects:create",
        vec![project_input(&folder), workspace["id"].clone()],
    );
    let project_id = project["id"].as_str().expect("project id");

    // 1. List artifacts
    let list_res = profile.rpc("artifacts:list", vec![json!(project_id)]);
    assert_eq!(list_res["available"], true);
    let items = list_res["items"].as_array().expect("items");
    assert_eq!(items.len(), 2);
    let page_item = items
        .iter()
        .find(|i| i["name"] == "page.html")
        .expect("page item");
    assert_eq!(page_item["kind"], "page");
    assert_eq!(page_item["title"], "Visual Page");

    // 2. Read text
    let text_content = profile.rpc(
        "artifacts:readText",
        vec![
            json!(project_id),
            json!("docs/published-artifacts/notes.md"),
        ],
    );
    assert_eq!(text_content, "# Architecture doc\nHello world");

    // 3. Create group
    let group = profile.rpc(
        "artifacts:createGroup",
        vec![
            json!(project_id),
            json!("Documentation"),
            json!(["docs/published-artifacts/notes.md"]),
        ],
    );
    assert_eq!(group["name"], "Documentation");
    let group_id = group["id"].as_str().expect("group id");

    // 4. Update group
    let updated = profile.rpc(
        "artifacts:updateGroup",
        vec![
            json!(project_id),
            json!(group_id),
            json!({"name": "Core Docs"}),
        ],
    );
    assert_eq!(updated["name"], "Core Docs");

    // 5. Delete artifact
    profile.rpc(
        "artifacts:delete",
        vec![
            json!(project_id),
            json!("docs/published-artifacts/notes.md"),
        ],
    );
    assert!(!text_file.exists());

    let after_delete = profile.rpc("artifacts:list", vec![json!(project_id)]);
    assert_eq!(after_delete["items"].as_array().expect("items").len(), 1);
}

#[test]
fn scheduled_runs_crud_lifecycle_and_views() {
    let profile = Profile::new();

    // 1. Initial list is empty
    let list_res = profile.rpc("scheduledRuns:list", vec![]);
    assert_eq!(list_res.as_array().expect("array").len(), 0);

    // 2. Save a new scheduled run
    let save_input = json!({
        "name": "Nightly Build & Test",
        "date": "2026-11-12",
        "time": "23:00",
        "timezone": "UTC",
        "tickets": [
            {
                "connectionId": "folder:test",
                "issueKey": "FX-101",
                "title": "Setup CI pipeline"
            }
        ],
        "withPrevious": [],
        "workflowId": "governed-delivery",
        "maxConcurrency": 1,
        "arm": false
    });
    let created = profile.rpc("scheduledRuns:save", vec![save_input]);
    assert_eq!(created["run"]["name"], "Nightly Build & Test");
    assert_eq!(created["run"]["status"], "draft");
    let run_id = created["run"]["id"].as_str().expect("run id");

    // 3. Get and list verify view construction
    let got = profile.rpc("scheduledRuns:get", vec![json!(run_id)]);
    assert_eq!(got["run"]["id"], run_id);
    assert_eq!(got["start"]["time"], "23:00");
    assert_eq!(got["readiness"]["ready"], true);

    let list_after = profile.rpc("scheduledRuns:list", vec![]);
    assert_eq!(list_after.as_array().expect("array").len(), 1);

    // 4. Rename
    let renamed = profile.rpc(
        "scheduledRuns:rename",
        vec![json!(run_id), json!("Renamed Nightly")],
    );
    assert_eq!(renamed["run"]["name"], "Renamed Nightly");

    // 5. Arm and hold
    let armed = profile.rpc("scheduledRuns:setArmed", vec![json!(run_id), json!(true)]);
    assert_eq!(armed["run"]["status"], "scheduled");

    let held = profile.rpc("scheduledRuns:setArmed", vec![json!(run_id), json!(false)]);
    assert_eq!(held["run"]["status"], "draft");

    // 6. Start now, pause, resume, cancel
    let started = profile.rpc("scheduledRuns:startNow", vec![json!(run_id)]);
    assert_eq!(started["run"]["status"], "running");
    assert_eq!(
        started["run"]["attempts"]
            .as_array()
            .expect("attempts")
            .len(),
        1
    );

    let paused = profile.rpc("scheduledRuns:pause", vec![json!(run_id)]);
    assert_eq!(paused["run"]["status"], "paused");

    let resumed = profile.rpc("scheduledRuns:resume", vec![json!(run_id)]);
    assert_eq!(resumed["run"]["status"], "running");

    let cancelled = profile.rpc("scheduledRuns:cancel", vec![json!(run_id)]);
    assert_eq!(cancelled["run"]["status"], "cancelled");

    // 7. Archive
    let archived = profile.rpc("scheduledRuns:archive", vec![json!(run_id), json!(true)]);
    assert_eq!(archived["run"]["archived"], true);

    // 8. Workflow choices
    let choices = profile.rpc("scheduledRuns:workflowChoices", vec![json!("p1")]);
    assert!(choices["choices"].as_array().expect("choices").len() >= 2);
    assert_eq!(choices["defaultWorkflowId"], "governed-delivery");

    // 9. Remove
    profile.rpc("scheduledRuns:remove", vec![json!(run_id)]);
    let list_final = profile.rpc("scheduledRuns:list", vec![]);
    assert_eq!(list_final.as_array().expect("array").len(), 0);
}

#[test]
fn workflows_templates_runs_lifecycle_and_policies() {
    let profile = Profile::new();
    let project_id = "test-project-123";

    // 1. Templates & Catalog
    let templates = profile.rpc("workflows:listTemplates", vec![json!(project_id)]);
    assert!(templates.as_array().expect("templates").len() >= 3);

    let catalog = profile.rpc("workflows:catalog", vec![json!(project_id)]);
    assert!(catalog["builtIn"].as_array().expect("built-ins").len() >= 3);

    // 2. Instantiate template
    let instantiated = profile.rpc(
        "workflows:instantiate",
        vec![
            json!(project_id),
            json!("governed-delivery"),
            json!("My Governed Flow"),
        ],
    );
    assert_eq!(instantiated["name"], "My Governed Flow");
    let workflow_id = instantiated["id"].as_str().expect("workflow id");

    // 3. Get definition
    let got_def = profile.rpc("workflows:get", vec![json!(project_id), json!(workflow_id)]);
    assert_eq!(got_def["id"], workflow_id);

    // 4. Policy save & effective policy
    let policy_profile = json!({
        "schemaVersion": 1,
        "id": "policy-p1",
        "name": "Project Policy",
        "scope": "project",
        "projectId": project_id,
        "requiredGates": ["qa", "review"],
        "requireHumanApproval": true,
        "allowGateBypass": false,
        "requireTrustedAgents": false,
        "maxAttemptsPerNode": 2,
        "createdAt": "2026-11-10T00:00:00.000Z",
        "updatedAt": "2026-11-10T00:00:00.000Z"
    });
    let saved_policy = profile.rpc("workflows:savePolicy", vec![policy_profile]);
    assert_eq!(saved_policy["id"], "policy-p1");

    let effective = profile.rpc("workflows:effectivePolicy", vec![json!(project_id)]);
    assert_eq!(effective["id"], "policy-p1");

    // 5. Start a workflow run
    let run_summary = profile.rpc(
        "workflows:startRun",
        vec![json!(project_id), json!(workflow_id), json!("Run tests")],
    );
    assert_eq!(run_summary["projectId"], project_id);
    let loops = run_summary["loops"]
        .as_array()
        .expect("renderer requires a loops array");
    assert!(
        !loops.is_empty(),
        "governed delivery exposes its declared loops"
    );
    assert!(
        loops
            .iter()
            .all(|entry| entry["history"].is_array() && entry["decisions"].is_array())
    );
    let run_id = run_summary["runId"].as_str().expect("run id");
    assert!(!run_summary["stages"].as_array().expect("stages").is_empty());

    // 6. List and get runs
    let runs_list = profile.rpc("workflows:listRuns", vec![json!(project_id)]);
    assert_eq!(runs_list.as_array().expect("runs").len(), 1);

    let got_run = profile.rpc("workflows:getRun", vec![json!(run_id)]);
    assert_eq!(got_run["runId"], run_id);

    // 7. Rename run
    let renamed_run = profile.rpc(
        "workflows:renameRun",
        vec![json!(run_id), json!("Custom Run Name")],
    );
    assert_eq!(renamed_run["workflowName"], "Custom Run Name");

    // 8. Advance stage
    let advanced = profile.rpc(
        "workflows:advanceStage",
        vec![json!(run_id), json!("plan"), json!("succeeded")],
    );
    assert_eq!(advanced["runId"], run_id);

    // 9. Cancel run
    let cancelled = profile.rpc(
        "workflows:cancelRun",
        vec![json!(run_id), json!("Test finished")],
    );
    assert_eq!(cancelled["status"], "cancelled");

    // 10. Archive run
    let archived = profile.rpc("workflows:archiveRun", vec![json!(run_id), json!(true)]);
    assert_eq!(archived["archived"], true);

    // 11. Delete run
    profile.rpc("workflows:deleteRun", vec![json!(run_id)]);
    let runs_after_delete = profile.rpc("workflows:listRuns", vec![json!(project_id)]);
    assert_eq!(runs_after_delete.as_array().expect("runs").len(), 0);
}

#[test]
fn system_mobile_pairing_and_clear_data() {
    let profile = Profile::new();

    // 1. Mobile host info snapshot
    let info = profile.rpc("settings:getMobileHostInfo", vec![]);
    assert_eq!(info["port"], 47833);
    assert_eq!(info["status"], "listening");

    // 2. Create pairing invitation
    let invitation = profile.rpc("settings:createMobilePairingInvitation", vec![]);
    assert!(invitation["pairingCode"].as_str().is_some());
    let code = invitation["pairingCode"]
        .as_str()
        .expect("pairing code")
        .to_string();

    // 3. Confirm pairing
    let confirmed = profile.rpc(
        "settings:confirmMobilePairing",
        vec![
            json!(code),
            json!({
                "label": "My iPhone",
                "capabilities": ["view", "edit"],
                "projectIds": ["proj-1"]
            }),
        ],
    );
    let devices = confirmed["devices"].as_array().expect("devices");
    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0]["name"], "My iPhone");
    let device_id = devices[0]["id"].as_str().expect("device id").to_string();

    // 4. Revoke device
    let revoked = profile.rpc("settings:revokeMobilePairedDevice", vec![json!(device_id)]);
    assert_eq!(revoked["devices"].as_array().expect("devices").len(), 0);

    // 5. Update checks and coordination
    let update_status = profile.rpc("update:getStatus", vec![]);
    assert_eq!(update_status["state"], "unsupported");

    let coord_state = profile.rpc("coordination:state", vec![]);
    assert_eq!(coord_state["role"], "follower");
    assert!(coord_state["blockedReason"].is_string());

    // 6. Clear session data
    let clear_result = profile.rpc("settings:clearSessionData", vec![]);
    assert_eq!(clear_result, Value::Null);
}

/// A one-thread HTTP server standing in for GitHub Packages: REST listing, packument, tarball.
fn mock_registry(addons: Vec<(&'static str, Value, Vec<(&'static str, String)>)>) -> String {
    use base64::Engine as _;
    use sha2::{Digest, Sha512};
    use std::io::{Read, Write};

    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let base = format!("http://{}", listener.local_addr().expect("addr"));
    let built: Vec<(&'static str, Value, Vec<u8>)> = addons
        .into_iter()
        .map(|(name, manifest, files)| {
            let mut builder = tar::Builder::new(Vec::new());
            let package = json!({ "name": name, "version": "1.0.0", "praxis": manifest }).to_string();
            let mut all = vec![("package/package.json".to_string(), package)];
            all.extend(files.into_iter().map(|(file, body)| (format!("package/addon/{file}"), body)));
            for (path, body) in all {
                let mut header = tar::Header::new_gnu();
                header.set_size(body.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                builder.append_data(&mut header, path, body.as_bytes()).expect("tar entry");
            }
            let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            gz.write_all(&builder.into_inner().expect("tar")).expect("gz");
            (name, manifest, gz.finish().expect("gz"))
        })
        .collect();
    let served = base.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut stream = stream;
            let mut buffer = [0u8; 4096];
            let read = stream.read(&mut buffer).unwrap_or(0);
            let request = String::from_utf8_lossy(&buffer[..read]).to_string();
            let path = request.split_whitespace().nth(1).unwrap_or("/").split('?').next().unwrap_or("/").to_string();
            let found = built.iter().find(|(name, _, _)| path == format!("/{name}") || path == format!("/{name}/-/{name}-1.0.0.tgz"));
            let (status, content_type, body): (u16, &str, Vec<u8>) = if path == "/users/acme/packages" {
                let list: Vec<Value> = built.iter().map(|(name, _, _)| json!({ "name": name, "updated_at": "2026-01-01T00:00:00Z" })).collect();
                (200, "application/json", json!(list).to_string().into_bytes())
            } else if let Some((name, manifest, tarball)) = found {
                if path.ends_with(".tgz") {
                    (200, "application/octet-stream", tarball.clone())
                } else {
                    let integrity = format!("sha512-{}", base64::engine::general_purpose::STANDARD.encode(Sha512::digest(tarball)));
                    let packument = json!({
                        "dist-tags": { "latest": "1.0.0" },
                        "versions": { "1.0.0": { "praxis": manifest, "dist": { "tarball": format!("{served}/{name}/-/{name}-1.0.0.tgz"), "integrity": integrity } } }
                    });
                    (200, "application/json", packument.to_string().into_bytes())
                }
            } else {
                (404, "application/json", b"{\"message\":\"no such package\"}".to_vec())
            };
            let head = format!("HTTP/1.1 {status} X\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len());
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(&body);
        }
    });
    base
}

#[test]
fn marketplace_catalog_install_and_trust() {
    let profile = Profile::new();
    let theme = json!({ "schemaVersion": 1, "kind": "theme", "id": "nord", "name": "Nord" });
    let agent = json!({ "schemaVersion": 1, "kind": "agent", "id": "tidy-bot", "name": "Tidy Bot" });
    let registry = mock_registry(vec![
        ("praxis-addon-nord", theme, vec![("theme.json", json!({ "name": "Nord", "mode": "dark", "preview": { "canvas": "#2e3440" } }).to_string())]),
        ("praxis-addon-tidy", agent, vec![("agent.json", json!({ "id": "tidy-bot", "name": "Tidy Bot", "type": "acp" }).to_string())]),
        ("unrelated-package", json!({}), vec![]),
    ]);

    let status = profile.rpc("marketplace:getStatus", vec![]);
    assert_eq!(status["packageNamePrefix"], "praxis-addon-");
    assert_eq!(status["ready"], false);
    // Without a configured marketplace the catalogue explains why instead of inventing entries.
    assert!(profile.try_rpc("marketplace:listCatalog", vec![]).is_err());

    let configured = profile.rpc(
        "marketplace:configure",
        vec![json!({ "enabled": true, "owner": "acme", "apiBaseUrl": registry, "registryBaseUrl": registry })],
    );
    assert_eq!(configured["owner"], "acme");
    profile.rpc("marketplace:setToken", vec![json!("ghp_test_token")]);
    let ready = profile.rpc("marketplace:getStatus", vec![]);
    assert_eq!((ready["hasToken"].clone(), ready["ready"].clone()), (json!(true), json!(true)));

    let catalog = profile.rpc("marketplace:listCatalog", vec![]);
    let names: Vec<&str> = catalog.as_array().expect("catalog").iter().map(|e| e["packageName"].as_str().unwrap_or_default()).collect();
    assert_eq!(names, ["praxis-addon-tidy", "praxis-addon-nord"]); // sorted by kind: agent < theme

    // A declarative add-on is active the moment it installs.
    let nord = profile.rpc("marketplace:install", vec![json!("praxis-addon-nord")]);
    assert_eq!((nord["manifest"]["id"].clone(), nord["enabled"].clone()), (json!("nord"), json!(true)));
    let appearance = profile.rpc("marketplace:listActiveAppearance", vec![]);
    assert_eq!(appearance["themes"][0]["preview"]["canvas"], "#2e3440");

    // An agent installs disabled, and only reaches the discovery root once trusted.
    let tidy = profile.rpc("marketplace:install", vec![json!("praxis-addon-tidy")]);
    assert_eq!(tidy["enabled"], false);
    let mirrored = profile.root.join("agents/tidy-bot/agent.json");
    assert!(!mirrored.exists());
    profile.rpc("marketplace:setTrust", vec![json!("agent"), json!("tidy-bot"), json!(true)]);
    assert!(mirrored.is_file());
    assert!(!profile.root.join("agents/tidy-bot/.praxis-addon.json").exists());
    profile.rpc("marketplace:setTrust", vec![json!("agent"), json!("tidy-bot"), json!(false)]);
    assert!(!mirrored.exists());

    assert_eq!(profile.rpc("marketplace:listInstalled", vec![]).as_array().expect("installed").len(), 2);
    assert_eq!(profile.rpc("marketplace:checkForUpdates", vec![]), json!([]));
    assert!(profile.try_rpc("marketplace:install", vec![json!("praxis-addon-missing")]).is_err());

    profile.rpc("marketplace:remove", vec![json!("theme"), json!("nord")]);
    assert_eq!(profile.rpc("marketplace:listInstalled", vec![]).as_array().expect("installed").len(), 1);
    assert_eq!(profile.rpc("marketplace:listActiveAppearance", vec![])["themes"], json!([]));
}

#[test]
fn deployments_credentials_and_artifacts() {
    let profile = Profile::new();

    // 1. Connection secret setup
    profile.rpc(
        "connection:setSecret",
        vec![
            json!("conn-1"),
            json!("DEPLOY_KEY"),
            json!("secret-val-123"),
        ],
    );
    let has_secret = profile.rpc(
        "connection:hasSecret",
        vec![json!("conn-1"), json!("DEPLOY_KEY")],
    );
    assert_eq!(has_secret, json!(true));

    // 2. Evaluate credentials against host secret store
    profile.host.secrets().set("PROD_API_KEY", "real-api-key");
    let eval_bound = profile.rpc(
        "deployments:evaluateCredentials",
        vec![json!({
            "credentials": {
                "apiKey": "${secret:PROD_API_KEY}"
            }
        })],
    );
    assert_eq!(eval_bound["allBound"], true);

    let eval_unbound = profile.rpc(
        "deployments:evaluateCredentials",
        vec![json!({
            "credentials": {
                "missingKey": "${secret:NONEXISTENT_KEY}"
            }
        })],
    );
    assert_eq!(eval_unbound["allBound"], false);

    // 3. Publish artifact
    let published = profile.rpc(
        "deployments:publishArtifact",
        vec![
            json!("art-1"),
            json!("prof-1"),
            json!("/build/out"),
            json!({ "kind": "git", "sha": "abcdef" }),
        ],
    );
    assert_eq!(published["artifact"]["id"], "art-1");

    // 4. Duplicate publish fails
    let dup_result = invoke(
        &profile.host,
        "deployments:publishArtifact",
        vec![json!("art-1"), json!("prof-1"), json!("/build/out")],
    );
    assert!(dup_result.is_err());

    // 5. List and get artifacts
    let list = profile.rpc("deployments:listArtifacts", vec![json!("prof-1")]);
    assert_eq!(list.as_array().expect("artifacts").len(), 1);

    let got = profile.rpc("deployments:getArtifact", vec![json!("art-1")]);
    assert_eq!(got["artifact"]["id"], "art-1");
}

#[test]
fn runs_services_and_task_designer_canvases() {
    let profile = Profile::new();

    // 1. Start runs and status
    profile.rpc("runs:start", vec![json!("proj-1")]);
    let statuses = profile.rpc("runs:status", vec![json!("proj-1")]);
    assert_eq!(statuses.as_array().expect("services")[0]["state"], "ready");

    // 2. Stop service
    profile.rpc("runs:stopService", vec![json!("proj-1"), json!("service")]);
    let stopped_statuses = profile.rpc("runs:status", vec![json!("proj-1")]);
    assert_eq!(
        stopped_statuses.as_array().expect("services")[0]["state"],
        "stopped"
    );

    // 3. Task designer canvas persistence
    let canvas_state = json!({
        "nodes": [{ "id": "node-1", "type": "task" }],
        "connectors": [],
        "viewport": { "x": 10.0, "y": 20.0, "zoom": 1.5 }
    });
    let saved_canvas = profile.rpc(
        "taskDesigner:setState",
        vec![json!("board-1"), json!("conn-1"), canvas_state.clone()],
    );
    assert_eq!(saved_canvas["ok"], true);

    let retrieved_canvas = profile.rpc(
        "taskDesigner:getState",
        vec![json!("board-1"), json!("conn-1")],
    );
    assert_eq!(
        retrieved_canvas["nodes"].as_array().expect("nodes").len(),
        1
    );
    assert_eq!(retrieved_canvas["viewport"]["zoom"], 1.5);

    // 4. Resolve issue
    let resolved = profile.rpc("taskDesigner:resolveIssue", vec![json!("FEAT-42")]);
    assert_eq!(resolved["mainIssue"]["issueKey"], "FEAT-42");
    assert_eq!(resolved["mainIssue"]["projectKey"], "FEAT");
}

#[test]
fn webviews_navigation_and_detached_chats() {
    let profile = Profile::new();

    // 1. Browser navigation and state
    let nav = profile.rpc("browser:navigate", vec![json!("https://example.com/test")]);
    assert_eq!(nav["ok"], true);
    assert_eq!(nav["url"], "https://example.com/test");

    let state = profile.rpc("browser:getState", vec![]);
    assert_eq!(state["url"], "https://example.com/test");
    assert_eq!(state["isLoading"], false);

    // Blocked browser navigation to private/loopback host
    let blocked_browser = invoke(
        &profile.host,
        "browser:navigate",
        vec![json!("http://127.0.0.1:8080")],
    );
    assert!(blocked_browser.is_err());
    let err_msg = blocked_browser
        .expect_err("expected blocked browser")
        .message;
    assert!(err_msg.contains("Refusing to open a loopback / private-network host"));

    // 2. Blocked preview open when origin has no preview grant
    let blocked_preview = invoke(
        &profile.host,
        "preview:open",
        vec![json!("http://localhost:3000")],
    );
    assert!(blocked_preview.is_err());
    let err_msg = blocked_preview
        .expect_err("expected blocked preview")
        .message;
    assert!(
        err_msg
            .contains("Refusing a loopback / private-network origin with no active preview grant")
    );

    // Allowed preview open for public origin
    profile.rpc("preview:open", vec![json!("https://example.com/preview")]);
    let diag = profile.rpc("preview:captureDiagnostics", vec![]);
    assert_eq!(diag["schemaVersion"], 1);
    assert_eq!(diag["projectId"], "preview");

    // 3. Detached chat list and lifecycle
    profile.rpc("detachedChat:open", vec![json!("TICK-101")]);
    let chats = profile.rpc("detachedChat:list", vec![]);
    assert_eq!(chats.as_array().expect("chats").len(), 1);
    assert_eq!(chats.as_array().expect("chats")[0], "TICK-101");

    profile.rpc("detachedChat:close", vec![json!("TICK-101")]);
    let empty_chats = profile.rpc("detachedChat:list", vec![]);
    assert_eq!(empty_chats.as_array().expect("chats").len(), 0);
}

#[tokio::test]
async fn guard_proxy_and_preview_security() {
    use crate::webviews::{
        LoopbackGuardProxy, PreviewAccessRegistry, blocked_browser_url_reason,
        is_private_or_loopback_host, preview_access_blocked_reason,
        resolved_browser_url_block_reason,
    };
    use std::sync::Arc;

    // 1. Literal host checks
    assert!(is_private_or_loopback_host("localhost"));
    assert!(is_private_or_loopback_host("sub.localhost"));
    assert!(is_private_or_loopback_host("127.0.0.1"));
    assert!(is_private_or_loopback_host("10.0.0.1"));
    assert!(is_private_or_loopback_host("192.168.1.1"));
    assert!(is_private_or_loopback_host("::1"));
    assert!(is_private_or_loopback_host("::ffff:127.0.0.1"));
    assert!(!is_private_or_loopback_host("example.com"));

    // 2. Synchronous block reason
    assert!(blocked_browser_url_reason("http://127.0.0.1:3000", false).is_some());
    assert!(blocked_browser_url_reason("http://localhost:8080", false).is_some());
    assert!(blocked_browser_url_reason("https://example.com", false).is_none());

    // 3. Preview access grants
    let registry = Arc::new(PreviewAccessRegistry::new());
    assert!(preview_access_blocked_reason("http://localhost:3000/app", &registry).is_some());

    registry.grant("http://localhost:3000", "proj-1", "run-1", "web");
    assert!(preview_access_blocked_reason("http://localhost:3000/app", &registry).is_none());
    assert!(registry.is_origin_granted("http://localhost:3000/foo/bar"));
    assert_eq!(
        registry
            .grant_for("http://localhost:3000")
            .expect("grant")
            .project_id,
        "proj-1"
    );

    registry.revoke_for_run("proj-1", "run-1");
    assert!(!registry.is_origin_granted("http://localhost:3000"));
    assert!(preview_access_blocked_reason("http://localhost:3000/app", &registry).is_some());

    // 4. DNS pre-resolution guard
    assert!(
        resolved_browser_url_block_reason("https://127.0.0.1:443", false)
            .await
            .is_err()
    );
    assert!(
        resolved_browser_url_block_reason("not a url", false)
            .await
            .is_err()
    );
    assert!(
        resolved_browser_url_block_reason("file:///etc/passwd", false)
            .await
            .is_err()
    );

    // 5. Loopback guard proxy lifecycle
    let proxy = LoopbackGuardProxy::start(registry, false)
        .await
        .expect("start proxy");
    assert!(proxy.port() > 0);
    assert!(proxy.proxy_url().starts_with("http://127.0.0.1:"));
}

#[test]
fn gadgets_publishing_and_submission() {
    let profile = Profile::new();
    // A gadget is pinned to a live session; text published for no session mints nothing.
    let unscoped = profile.rpc("gadgets:publishFromText", vec![json!("sess-1"), json!("pref"), json!("```praxis-gadget\n{}\n```")]);
    assert!(unscoped.as_array().expect("blocks").is_empty());
    super::session_store::store(&profile.root).put("SESSION-1", json!({ "issueKey": "SESSION-1", "sessionId": "sess-1", "state": "completed" })).expect("session");

    // 1. Publish from text with a choice gadget
    let text_with_gadget = r#"
Here is a choice for you:
```praxis-gadget
{"version":1,"kind":"choice","gadgetId":"opt-1","payload":{"question":"Proceed?","options":[{"value":"yes","label":"Yes"}]},"actions":[{"actionId":"pick","label":"Pick","effect":"informational"}]}
```
"#;
    let published = profile.rpc(
        "gadgets:publishFromText",
        vec![json!("sess-1"), json!("pref"), json!(text_with_gadget)],
    );
    assert!(!published.as_array().expect("blocks").is_empty());

    let blocks = profile.rpc("gadgets:getBlocks", vec![json!("sess-1")]);
    assert!(!blocks.as_array().expect("blocks").is_empty());

    // 2. Submit gadget action
    let submit_req = json!({
        "sessionId": "sess-1",
        "gadgetId": "opt-1",
        "actionId": "pick",
        "value": { "kind": "choice", "selected": "yes" }
    });
    let result = profile.rpc("gadgets:submit", vec![submit_req.clone()]);
    assert_eq!(result["status"], "completed");
    assert_eq!(result["replay"], false);
    let blocks = profile.rpc("gadgets:getBlocks", vec![json!("sess-1")]);
    let gadget = blocks.as_array().expect("blocks").iter().find(|b| b["type"] == "gadget").expect("gadget");
    assert_eq!(gadget["gadget"]["state"], "completed");
    assert_eq!(gadget["gadget"]["answer"]["selected"], "yes");

    // The same submission again is a replay, and a different answer under that key is refused.
    let mut again = submit_req.clone();
    again["idempotencyKey"] = result["idempotencyKey"].clone();
    assert_eq!(profile.rpc("gadgets:submit", vec![again.clone()])["replay"], true);
    again["value"] = json!({ "kind": "choice", "selected": "no" });
    assert_eq!(profile.rpc("gadgets:submit", vec![again])["error"]["code"], "duplicate-action");

    // 3. Clear session gadgets
    profile.rpc("gadgets:clear", vec![json!("sess-1")]);
    let cleared = profile.rpc("gadgets:getBlocks", vec![json!("sess-1")]);
    assert_eq!(cleared.as_array().expect("empty").len(), 0);
}

#[test]
fn ai_usage_and_provider_snapshots() {
    let profile = Profile::new();

    // 1. Dashboard summary
    let summary = profile.rpc("aiUsage:dashboardSummary", vec![]);
    assert!(summary.get("today").is_some());
    assert!(summary.get("week").is_some());
    assert!(summary["allTime"]["models"].is_array());

    // 2. Series and compare
    let series = profile.rpc("aiUsage:series", vec![json!("day"), json!(7)]);
    assert!(series.as_array().is_some());

    let compare = profile.rpc("aiUsage:compareLatestPeriod", vec![json!("day")]);
    assert!(compare.get("current").is_some());

    // 3. Provider usage key secrets
    profile.rpc(
        "aiUsage:setProviderUsageKey",
        vec![json!("openai"), json!("sk-secret-test")],
    );
    assert!(profile.host.secrets().has("ai-usage:openai"));

    // 4. Snapshots
    let snapshots = profile.rpc("aiUsage:providerSnapshots", vec![json!(["openai"])]);
    assert_eq!(
        snapshots["snapshots"].as_array().expect("snaps")[0]["provider"],
        "openai"
    );
    assert!(snapshots["checkedAt"].is_string());
}

#[test]
fn assistant_chats_lifecycle() {
    let profile = Profile::new();

    // 1. Create chat
    let chat = profile.rpc(
        "assistant:createChat",
        vec![json!("proj-1"), json!("FEAT-10")],
    );
    let chat_id = chat["id"].as_str().expect("chatId");
    assert_eq!(chat["projectId"], "proj-1");
    assert_eq!(chat["issueKey"], "FEAT-10");

    // 2. List chats
    let list = profile.rpc("assistant:listChats", vec![json!("proj-1")]);
    assert_eq!(list.as_array().expect("chats").len(), 1);

    // 3. Save chat messages
    let messages = json!([
        { "id": "m-1", "role": "user", "content": "Hello team" },
        { "id": "m-2", "role": "assistant", "personaId": "lead", "content": "Hello!" }
    ]);
    let saved = profile.rpc("assistant:saveChat", vec![json!(chat_id), messages]);
    assert_eq!(saved["messages"].as_array().expect("msgs").len(), 2);

    // 4. Rename and archive
    let renamed = profile.rpc(
        "assistant:renameChat",
        vec![json!(chat_id), json!("Updated Title")],
    );
    assert_eq!(renamed["title"], "Updated Title");

    let archived = profile.rpc("assistant:archiveChat", vec![json!(chat_id), json!(true)]);
    assert_eq!(archived["archived"], true);

    // 5. Delete chat
    profile.rpc("assistant:deleteChat", vec![json!(chat_id)]);
    let empty_list = profile.rpc("assistant:listChats", vec![json!("proj-1")]);
    assert_eq!(empty_list.as_array().expect("empty").len(), 0);
}

#[test]
fn agent_runtime_roots_and_authoring() {
    let profile = Profile::new();

    // 1. Roots
    let roots = profile.rpc("agentRuntime:roots", vec![]);
    assert!(roots["native"].as_str().is_some());
    assert!(roots["user"].as_str().is_some());

    // The renderer requires a snapshot, including empty host/capability maps.
    let items = profile.rpc("agentRuntime:list", vec![]);
    assert!(items["agents"].is_array());
    assert!(items["skills"].is_array());
    assert!(items["hosts"].is_object());
    assert!(items["capabilities"].is_object());

    // The roots Settings renders carry both scopes for every catalog.
    for catalog in ["agents", "runtimeHosts", "profiles", "skills"] {
        assert!(roots[catalog]["global"].as_str().is_some(), "{catalog}.global");
        assert!(roots[catalog]["project"].as_str().is_some(), "{catalog}.project");
    }

    // Built-ins are mirrored and listed on first use.
    assert!(items["profiles"].as_array().expect("profiles").iter().any(|p| p["profile"]["id"] == "praxis-scheduler"));
    assert!(items["skills"].as_array().expect("skills").iter().any(|s| s["metadata"]["name"] == "praxis-scheduled-runs"));

    // 3. Create a launch binding: returns the refreshed snapshot and writes a real manifest.
    let created = profile.rpc(
        "agentRuntime:createAgent",
        vec![json!({
            "scope": "global", "id": "code-debugger", "name": "Code Debugger", "transport": "acp",
            "command": "sleep", "args": ["30"], "scaffold": false
        })],
    );
    let host = created["runtimeHosts"].as_array().expect("hosts").iter().find(|h| h["manifest"]["id"] == "code-debugger").expect("listed");
    assert_eq!(host["trusted"], true);
    assert!(profile.root.join("agents/code-debugger/agent.json").exists());

    // A duplicate or invalid request is refused and writes nothing.
    assert!(profile.try_rpc("agentRuntime:createAgent", vec![json!({"scope":"global","id":"code-debugger","name":"X","transport":"acp","command":"sleep"})]).is_err());
    assert!(profile.try_rpc("agentRuntime:createAgent", vec![json!({"scope":"global","id":"Bad Id","name":"X","transport":"acp","command":"sleep"})]).is_err());

    // 4. Start and stop a real host process.
    #[cfg(unix)]
    {
        let started = profile.rpc("agentRuntime:start", vec![json!("code-debugger")]);
        assert_eq!(started["hosts"]["code-debugger"]["state"], "running");
        assert!(started["hosts"]["code-debugger"]["pid"].as_u64().is_some());
        assert!(started["capabilities"]["code-debugger"].is_object());
        let stopped = profile.rpc("agentRuntime:stop", vec![json!("code-debugger")]);
        assert!(stopped["hosts"]["code-debugger"].is_null());
    }

    // Starting something undiscovered fails with the TypeScript wording.
    let missing = profile.try_rpc("agentRuntime:start", vec![json!("nope")]).expect_err("undiscovered");
    assert!(missing.message.contains("Runtime host nope was not discovered."));
}

#[test]
fn ai_sessions_and_analysis_lifecycle() {
    let profile = Profile::new();

    // 1. Provider status
    // The active provider is unconfigured until it has a key; it is never reported ready for free.
    let status = profile.rpc("ai:getStatus", vec![]);
    assert_eq!((status["provider"].as_str(), status["configured"].as_bool()), (Some("vercel-gateway"), Some(false)));
    profile.rpc("ai:setApiKey", vec![json!("gateway-key")]);
    assert_eq!(profile.rpc("ai:getStatus", vec![])["configured"], true);

    let providers = profile.rpc("ai:listProviderStatuses", vec![]);
    assert!(providers.as_array().expect("providers").len() >= 3);

    // 2. A multi-AI conversation needs a session, a mode and a second AI.
    let error = profile.try_rpc("ai:startConversation", vec![json!("TASK-99"), json!({})]).expect_err("mode required");
    assert!(error.message.contains("Choose a conversation mode"));
    let error = profile.try_rpc("ai:startConversation", vec![json!("TASK-99"), json!({ "mode": "consult", "provider": "openai", "turnCap": 2 })]).expect_err("no session");
    assert!(error.message.contains("No agent session found for TASK-99"));
    let error = profile.try_rpc("ai:sendConversationMessage", vec![json!("TASK-99"), json!({ "participantId": "host", "message": "hi" })]).expect_err("no conversation");
    assert!(error.message.contains("No running multi-AI conversation"));

    // 3. Analysis submit, confirm, clear
    let analysis_data = json!({
        "summary": "High CPU utilization in PTY reader",
        "suggestedFix": "Batch chunk read buffers"
    });
    profile.rpc(
        "ai:submitAnalysis",
        vec![json!("TASK-99"), analysis_data.clone()],
    );
    let analysis = profile.rpc("ai:getAnalysis", vec![json!("TASK-99")]);
    assert_eq!(analysis["summary"], "High CPU utilization in PTY reader");

    profile.rpc(
        "ai:setAnalysisConfirmed",
        vec![json!("TASK-99"), json!(true)],
    );
    let confirmed_analysis = profile.rpc("ai:getAnalysis", vec![json!("TASK-99")]);
    assert_eq!(confirmed_analysis["confirmed"], true);

    profile.rpc("ai:clearAnalysis", vec![json!("TASK-99")]);
    let cleared_analysis = profile.rpc("ai:getAnalysis", vec![json!("TASK-99")]);
    assert!(cleared_analysis.is_null());

    // 4. Session deletion
    profile.rpc("ai:deleteSession", vec![json!("TASK-99")]);
    let deleted_session = profile.rpc("ai:getSession", vec![json!("TASK-99")]);
    assert!(deleted_session.is_null());
}

#[test]
fn electron_session_index_hydrates_partial_transcripts_and_preserves_metadata() {
    let profile = Profile::new();
    let file = profile.root.join("ai-sessions.json");
    let index = json!({"unrelated": {"keep": true}, "praxis.agentSessions": {
        "SESSION-old": {"issueKey": "SESSION-old", "sessionId": "runtime:old", "title": "Saved conversation",
            "startedAt": "2026-11-01T00:00:00Z", "state": "completed", "eventsLoaded": false,
            "events": [{"type": "subagent", "timestamp": "2026-11-02T00:00:00Z"}],
            "conversationHistory": [{"role": "system", "content": "provider-private"}]}
    }});
    fs::write(&file, index.to_string()).expect("valid compatibility fixture");
    let transcripts = profile.root.join("ai-transcripts");
    fs::create_dir(&transcripts).expect("valid compatibility fixture");
    let transcript = json!({"events": [{"type": "assistant_message", "summary": "Saved reply"}, {"type": "user_input_completed", "summary": "Follow-up"}],
        "responseText": "Saved reply", "conversationHistory": [{"role": "system", "content": "private"}]});
    fs::write(transcripts.join("runtime_old.json"), transcript.to_string())
        .expect("valid compatibility fixture");
    let before = fs::read(&file).expect("valid compatibility fixture");
    let list = profile.rpc("ai:listSessions", vec![]);
    assert_eq!(list[0]["title"], "Saved conversation");
    assert_eq!(list[0]["events"], json!([]));
    assert_eq!(list[0]["eventsLoaded"], false);
    assert_eq!(list[0]["lastActivityAt"], "2026-11-02T00:00:00Z");
    assert!(list[0].get("conversationHistory").is_none());
    for key in ["SESSION-old", "runtime:old"] {
        let detail = profile.rpc("ai:getSession", vec![json!(key)]);
        assert_eq!(detail["events"], transcript["events"]);
        assert_eq!(detail["eventsLoaded"], true);
        assert_eq!(detail["eventCount"], 2);
        assert!(detail.get("conversationHistory").is_none());
    }
    assert_eq!(
        fs::read(&file).expect("valid compatibility fixture"),
        before,
        "reads must not migrate or rewrite the user's index"
    );
    profile.rpc(
        "ai:renameSession",
        vec![json!("SESSION-old"), json!("Renamed")],
    );
    let saved: Value =
        serde_json::from_slice(&fs::read(&file).expect("valid compatibility fixture"))
            .expect("valid compatibility fixture");
    assert_eq!(saved["unrelated"], index["unrelated"]);
    assert_eq!(
        saved["praxis.agentSessions"]["SESSION-old"]["title"],
        "Renamed"
    );
    fs::write(transcripts.join("runtime_old.json"), "{broken")
        .expect("valid compatibility fixture");
    assert!(invoke(&profile.host, "ai:getSession", vec![json!("SESSION-old")]).is_err());
}

#[test]
fn saved_conversation_reads_are_independent_of_catalog_errors_and_writer_lock() {
    let profile = Profile::new();
    fs::write(profile.root.join("projects.json"), "{broken-catalog")
        .expect("broken catalog fixture");
    fs::write(profile.root.join("ai-sessions.json"), json!({"praxis.agentSessions": {"SESSION-saved": {"issueKey": "SESSION-saved", "sessionId": "runtime-saved", "events": []}}}).to_string()).expect("session index");
    fs::write(profile.root.join("team-chats.json"), json!({"schemaVersion": 2, "revision": 1, "conversations": [{"id": "saved-chat", "messages": []}], "teamChats": []}).to_string()).expect("chats");
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(profile.root.join("desktop-state.praxis.lock"))
        .expect("catalog lock");
    lock.try_lock().expect("hold another writer lock");
    assert_eq!(
        profile.rpc("ai:listSessions", vec![])[0]["issueKey"],
        "SESSION-saved"
    );
    assert_eq!(
        profile.rpc("ai:getSession", vec![json!("SESSION-saved")])["sessionId"],
        "runtime-saved"
    );
    assert_eq!(
        profile.rpc("assistant:listChats", vec![])[0]["id"],
        "saved-chat"
    );
    assert_eq!(
        profile.rpc("assistant:getConversation", vec![json!("saved-chat")])["id"],
        "saved-chat"
    );
    assert_eq!(
        profile.rpc("marketplace:listActiveAppearance", vec![])["themes"],
        json!([])
    );
    assert_eq!(
        fs::read_to_string(profile.root.join("projects.json")).expect("catalog remains untouched"),
        "{broken-catalog"
    );
}

#[test]
fn electron_durable_chats_preserve_activation_and_unknown_fields() {
    let profile = Profile::new();
    let file = profile.root.join("team-chats.json");
    let doc = json!({"schemaVersion": 2, "revision": 81, "teamChats": [],
        "activation": {"version": 1, "acceptedNewTurns": true}, "futureMetadata": {"keep": 42},
        "conversations": [{"id": "chat-existing", "projectId": "project-existing", "title": "Existing team chat",
            "createdAt": "2026-11-01T00:00:00Z", "updatedAt": "2026-11-02T00:00:00Z", "revision": 12,
            "participants": [], "turns": [], "bindings": [], "summaries": [], "pinnedMessageIds": [],
            "messages": [{"id": "m1", "role": "user", "text": "Saved question", "createdAt": "2026-11-01T00:00:00Z"}],
            "commandReceipts": [{"commandId": "keep-this-receipt"}], "futureField": true}]});
    fs::write(&file, doc.to_string()).expect("valid compatibility fixture");
    let before = fs::read(&file).expect("valid compatibility fixture");
    let list = profile.rpc("assistant:listChats", vec![json!("project-existing")]);
    assert_eq!(list[0]["id"], "chat-existing");
    assert_eq!(list[0]["messageCount"], 1);
    assert_eq!(
        profile.rpc("assistant:listChats", vec![json!("other-project")]),
        json!([])
    );
    let conversation = profile.rpc("assistant:getConversation", vec![json!("chat-existing")]);
    assert_eq!(conversation, doc["conversations"][0]);
    assert_eq!(
        fs::read(&file).expect("valid compatibility fixture"),
        before
    );
    profile.rpc(
        "assistant:renameChat",
        vec![json!("chat-existing"), json!("New title")],
    );
    let saved: Value =
        serde_json::from_slice(&fs::read(&file).expect("valid compatibility fixture"))
            .expect("valid compatibility fixture");
    assert_eq!(saved["activation"], doc["activation"]);
    assert_eq!(saved["futureMetadata"], doc["futureMetadata"]);
    assert_eq!(
        saved["conversations"][0]["commandReceipts"],
        doc["conversations"][0]["commandReceipts"]
    );
    assert_eq!(
        saved["conversations"][0]["messages"],
        conversation["messages"]
    );
    assert_eq!(saved["revision"], 82);
}

#[test]
fn electron_installed_theme_is_loaded_with_saved_look_without_network() {
    let profile = Profile::new();
    let dir = profile.root.join("addons/theme/github-dark");
    fs::create_dir_all(&dir).expect("valid compatibility fixture");
    fs::write(
        dir.join(".praxis-addon.json"),
        json!({"manifest": {"schemaVersion": 1, "kind": "theme", "id": "github-dark", "name": "GitHub Dark"}, "enabled": true}).to_string(),
    )
    .expect("valid compatibility fixture");
    fs::write(dir.join("theme.json"), json!({"name": "GitHub Dark", "mode": "dark", "preview": {"canvas": "#0d1117", "accent": "#2f81f7"}}).to_string()).expect("valid compatibility fixture");
    let settings = json!({"appearance": {"themeId": "github-dark", "themeMode": "dark", "surfacePackId": "parchment",
        "activeLookId": "look-saved", "zoomFactor": 1.2,
        "looks": [{"id": "look-saved", "name": "My look", "themeId": "github-dark", "themeMode": "dark", "surfacePackId": "parchment", "surface": {"intensity": 0.9}}]}});
    fs::write(profile.root.join("settings.json"), settings.to_string())
        .expect("valid compatibility fixture");
    let loaded = profile.rpc("settings:get", vec![]);
    assert_eq!(loaded["appearance"]["activeLookId"], "look-saved");
    assert_eq!(loaded["appearance"]["looks"][0]["themeId"], "github-dark");
    assert_eq!(loaded["appearance"]["zoomFactor"], 1.2);
    let appearance = profile.rpc("marketplace:listActiveAppearance", vec![]);
    assert_eq!(appearance["themes"][0]["id"], "github-dark");
    assert_eq!(appearance["themes"][0]["preview"]["canvas"], "#0d1117");
}

#[test]
fn session_support_snapshots_have_renderer_required_fields() {
    let profile = Profile::new();
    let coordination = profile.rpc("coordination:state", vec![]);
    assert!(coordination["state"]["sessions"].is_object());
    for key in ["claims", "waiters", "events"] {
        assert!(coordination["state"][key].is_array());
    }
    assert!(coordination["blockedReason"].is_string());
    let readiness = profile.rpc(
        "workflows:templateReadiness",
        vec![json!("project-existing")],
    );
    assert!(
        !readiness
            .as_array()
            .expect("valid compatibility fixture")
            .is_empty()
    );
    for template in readiness.as_array().expect("valid compatibility fixture") {
        assert!(template["blockingByNode"].is_object());
        assert_eq!(
            template["agentsOk"], false,
            "unverified executors must not be advertised as ready"
        );
    }
}

/// Opt-in verification of a temporary profile copy; never run against live user data.
#[test]
#[ignore = "requires PRAXIS_COMPAT_PROFILE pointing to a temporary copied profile"]
fn existing_profile_read_compatibility() {
    let root = PathBuf::from(std::env::var("PRAXIS_COMPAT_PROFILE").expect("copied profile path"));
    let root = fs::canonicalize(root).expect("valid compatibility fixture");
    assert!(
        root.starts_with(
            fs::canonicalize(std::env::temp_dir()).expect("valid compatibility fixture")
        )
    );
    let host = Profile::open(&root);
    let session_bytes =
        fs::read(root.join("ai-sessions.json")).expect("valid compatibility fixture");
    let chat_bytes = fs::read(root.join("team-chats.json")).expect("valid compatibility fixture");
    let settings_bytes = fs::read(root.join("settings.json")).expect("valid compatibility fixture");
    let stored: Value =
        serde_json::from_slice(&session_bytes).expect("valid compatibility fixture");
    let sessions = invoke(&host, "ai:listSessions", vec![]).expect("valid compatibility fixture");
    assert_eq!(
        sessions
            .as_array()
            .expect("valid compatibility fixture")
            .len(),
        stored["praxis.agentSessions"]
            .as_object()
            .expect("valid compatibility fixture")
            .len()
    );
    let recent: Vec<_> = sessions
        .as_array()
        .expect("valid compatibility fixture")
        .iter()
        .filter(|s| s["archived"] != true)
        .take(3)
        .collect();
    for record in &recent {
        let detail = invoke(&host, "ai:getSession", vec![record["issueKey"].clone()])
            .expect("valid compatibility fixture");
        assert_eq!(detail["sessionId"], record["sessionId"]);
        assert!(
            detail["events"]
                .as_array()
                .is_some_and(|events| !events.is_empty())
        );
        assert_eq!(detail["eventsLoaded"], true);
    }
    let chats: Value = serde_json::from_slice(&chat_bytes).expect("valid compatibility fixture");
    let listed = invoke(&host, "assistant:listChats", vec![]).expect("valid compatibility fixture");
    assert_eq!(
        listed
            .as_array()
            .expect("valid compatibility fixture")
            .len(),
        chats["conversations"]
            .as_array()
            .expect("valid compatibility fixture")
            .len()
    );
    for chat in chats["conversations"]
        .as_array()
        .expect("valid compatibility fixture")
    {
        let detail = invoke(&host, "assistant:getConversation", vec![chat["id"].clone()])
            .expect("valid compatibility fixture");
        assert_eq!(&detail, chat);
    }
    let settings = invoke(&host, "settings:get", vec![]).expect("valid compatibility fixture");
    let appearance = invoke(&host, "marketplace:listActiveAppearance", vec![])
        .expect("valid compatibility fixture");
    let saved: Value =
        serde_json::from_slice(&settings_bytes).expect("valid compatibility fixture");
    assert_eq!(
        settings["appearance"]["activeLookId"],
        saved["appearance"]["activeLookId"]
    );
    let theme_id = settings["appearance"]["themeId"]
        .as_str()
        .expect("valid compatibility fixture");
    assert!(
        appearance["themes"]
            .as_array()
            .expect("valid compatibility fixture")
            .iter()
            .any(|theme| theme["id"] == theme_id)
    );
    assert_eq!(
        fs::read(root.join("ai-sessions.json")).expect("valid compatibility fixture"),
        session_bytes
    );
    assert_eq!(
        fs::read(root.join("team-chats.json")).expect("valid compatibility fixture"),
        chat_bytes
    );
    assert_eq!(
        fs::read(root.join("settings.json")).expect("valid compatibility fixture"),
        settings_bytes
    );
    println!(
        "Copied profile: {} session summaries; {} recent transcripts; {} complete team chats; saved theme {} present; source stores unchanged.",
        sessions
            .as_array()
            .expect("valid compatibility fixture")
            .len(),
        recent.len(),
        listed
            .as_array()
            .expect("valid compatibility fixture")
            .len(),
        theme_id
    );
}

#[cfg(unix)]
#[test]
fn provider_statuses_are_real_and_keys_use_the_migrated_secret_names() {
    use std::os::unix::fs::PermissionsExt;
    let profile = Profile::new();

    // A CLI provider is "configured" only when its command resolves to an executable.
    let tool = profile.root.join("fake-agent");
    fs::write(&tool, "#!/bin/sh\necho 'fake-agent 4.5.6'\n").expect("script");
    fs::set_permissions(&tool, fs::Permissions::from_mode(0o755)).expect("chmod");
    profile.rpc("settings:set", vec![json!({"ai": {"providers": {"claude-code-cli": {"cliPath": tool}, "codex-cli": {"cliPath": profile.root.join("absent")}}}})]);
    let statuses = profile.rpc("ai:listProviderStatuses", vec![]);
    let by_id = |id: &str| statuses.as_array().expect("list").iter().find(|s| s["provider"] == id).cloned().expect("provider listed");
    let claude = by_id("claude-code-cli");
    assert_eq!((claude["kind"].as_str(), claude["configured"].as_bool()), (Some("cli-agent"), Some(true)));
    assert_eq!((claude["preflight"]["status"].as_str(), claude["preflight"]["providerVersion"].as_str()), (Some("ready"), Some("4.5.6")));
    assert_eq!(by_id("codex-cli")["configured"], false, "a missing CLI is not configured");
    assert_eq!(by_id("codex-cli")["preflight"]["status"], "unavailable");
    assert_eq!(statuses.as_array().expect("list").len(), 10, "every built-in provider is listed");

    // API keys: stored under the Electron-era name, trimmed, never echoed, cleared by an empty value.
    assert_eq!(by_id("gemini")["configured"], false);
    let set = profile.rpc("ai:setProviderApiKey", vec![json!("gemini"), json!("  sk-secret  ")]);
    assert_eq!((set["configured"].as_bool(), set["keySource"].as_str()), (Some(true), Some("secret")));
    assert!(!set.to_string().contains("sk-secret"), "the key value never crosses IPC");
    assert_eq!(profile.host.secrets().get("praxis.geminiApiKey").as_deref(), Some("sk-secret"));
    let cleared = profile.rpc("ai:setProviderApiKey", vec![json!("gemini"), json!("")]);
    assert_eq!(cleared["configured"], false);
    assert!(!profile.host.secrets().has("praxis.geminiApiKey"));

    // Keys must never be written in the clear next to the profile's legacy secrets file.
    profile.rpc("ai:setProviderApiKey", vec![json!("openai"), json!("sk-also-secret")]);
    assert!(!profile.root.join("secrets.json").exists(), "no plaintext side file");

    // Unknown providers and built-ins that cannot be removed are refused with a reason.
    assert!(profile.try_rpc("ai:setProviderApiKey", vec![json!("nope"), json!("x")]).expect_err("unknown").message.contains("Unknown AI provider"));
    assert!(profile.try_rpc("ai:removeCustomProvider", vec![json!("openai")]).expect_err("built-in").message.contains("built-in provider"));

    // Reset clears every API provider's key.
    profile.rpc("ai:resetProviderApiKeys", vec![]);
    assert!(!profile.host.secrets().has("praxis.openaiApiKey"));
}

#[test]
fn other_tools_project_files_are_untrusted_until_approved_and_can_be_copied() {
    let profile = Profile::new();
    let repo = profile.root.join("repo");
    fs::create_dir_all(repo.join(".git")).expect("git dir");
    fs::create_dir_all(repo.join(".claude/agents")).expect("agents dir");
    fs::create_dir_all(repo.join(".claude/skills/deploy")).expect("skills dir");
    fs::write(repo.join(".claude/agents/release-notes.md"), "---\nname: release-notes\ndescription: Drafts notes.\ntools: Read\n---\nSign off.").expect("agent");
    fs::write(repo.join(".claude/skills/deploy/SKILL.md"), "---\nname: deploy\ndescription: Deploys.\n---\nSteps.").expect("skill");
    fs::write(repo.join("AGENTS.md"), "Be kind.").expect("instructions");
    profile.rpc("settings:set", vec![json!({ "ai": { "workingDirectory": repo } })]);

    let find = |snapshot: &Value, id: &str| snapshot["profiles"].as_array().expect("profiles").iter().find(|p| p["profile"]["id"] == id).cloned();
    let snapshot = profile.rpc("agentRuntime:refresh", vec![]);
    let agent = find(&snapshot, "release-notes").expect("discovered in place");
    assert_eq!((agent["trusted"].as_bool(), agent["source"]["ecosystem"].as_str(), agent["profile"]["toolMode"].as_str()), (Some(false), Some("claude"), Some("read-only")));
    assert_eq!(snapshot["nativeProject"]["approved"], false);
    assert!(snapshot["instructions"].as_array().expect("instructions").iter().any(|file| file["displayPath"] == "AGENTS.md"));
    assert!(profile.try_rpc("agentRuntime:copyNative", vec![json!("agent"), json!("release-notes")]).expect_err("untrusted").message.contains("Approve this project"));

    let root = snapshot["nativeProject"]["root"].as_str().expect("root").to_owned();
    let approved = profile.rpc("agentRuntime:approveNativeProject", vec![json!(root), json!(true)]);
    assert_eq!(approved["nativeProject"]["approved"], true);
    assert_eq!(find(&approved, "release-notes").expect("still listed")["trusted"], true);

    let copied = profile.rpc("agentRuntime:copyNative", vec![json!("agent"), json!("release-notes")]);
    assert!(profile.root.join("agents/release-notes/AGENT.md").is_file());
    let own = find(&copied, "release-notes").expect("copy listed");
    assert!(own.get("source").is_none_or(Value::is_null), "the copy takes over from the original");
    assert!(own["alsoIn"].as_array().expect("also in")[0].as_str().expect("label").starts_with("Claude Code"));
    profile.rpc("agentRuntime:copyNative", vec![json!("skill"), json!("deploy")]);
    assert!(profile.root.join("skills/deploy/SKILL.md").is_file());
    assert!(profile.try_rpc("agentRuntime:revealNative", vec![json!("/etc/passwd")]).expect_err("only discovered paths").message.contains("not found by discovery"));
}

#[test]
fn a_bound_session_needs_both_halves_and_a_discovered_trusted_host() {
    let profile = Profile::new();
    let launch = |input: Value| profile.try_rpc("ai:delegate", vec![input]).expect_err("launch refused").message;
    assert_eq!(launch(json!({ "profileId": "x", "goal": "g" })), "A session binding requires both an agent profile and runtime host.");
    assert_eq!(launch(json!({ "profileId": "x", "hostId": "missing-host", "goal": "g" })), "Runtime host \"missing-host\" was not discovered.");
    profile.rpc("agentRuntime:createAgent", vec![json!({ "scope": "global", "id": "bound-host", "name": "Bound Host", "transport": "acp", "command": "sleep" })]);
    assert_eq!(launch(json!({ "profileId": "no-profile", "hostId": "bound-host", "goal": "g" })), "Agent profile no-profile was not discovered.");
}
