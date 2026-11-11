use super::*;
use std::sync::Mutex;

fn vectors() -> Value {
    serde_json::from_str(include_str!(
        "../../../tests/fixtures/ts_host_services.json"
    ))
    .expect("TS vectors")
}

struct Deps {
    config: Value,
    calls: Mutex<Vec<Value>>,
}

impl Deps {
    fn note(&self, name: &str, arguments: Value) -> Value {
        let mut call = vec![json!(name)];
        call.extend(arguments.as_array().expect("arguments").iter().cloned());
        self.calls.lock().expect("calls").push(json!(call));
        json!({"ok": name})
    }
    fn snapshot(&self) -> MobileSessionSnapshot {
        serde_json::from_value(
            self.config
                .get("session")
                .cloned()
                .unwrap_or_else(|| vectors()["session"].clone()),
        )
        .expect("session")
    }
    fn schedule(&self) -> super::super::scheduled_runs::MobileScheduledRun {
        serde_json::from_value(json!({
            "id": "schedule-1", "projectId": "p1", "name": "Tonight", "status": "draft",
            "scheduledStartAt": "2026-10-25T20:30:00.000Z", "timezone": "Europe/London", "entries": []
        })).expect("schedule")
    }
}

#[async_trait]
impl MobileHostServiceDeps for Arc<Deps> {
    fn host_id(&self) -> String {
        "host".into()
    }
    fn host_name(&self) -> String {
        "Mac".into()
    }
    fn host_online(&self) -> bool {
        true
    }
    fn host_epoch(&self) -> String {
        "epoch-1".into()
    }
    fn latest_sequence(&self) -> u64 {
        41
    }
    fn appearance(&self) -> Option<Value> {
        self.config.get("appearance").cloned()
    }
    fn schedules(&self) -> Option<Arc<dyn MobileSchedules>> {
        (self.config["schedules"] == true)
            .then(|| Arc::new(self.clone()) as Arc<dyn MobileSchedules>)
    }
    async fn provider_catalog(
        &self,
        project: Option<&str>,
    ) -> Result<MobileProviderCatalog, String> {
        self.note("providerCatalog", json!([project]));
        Ok(serde_json::from_value(vectors()["catalog"].clone()).expect("catalog"))
    }
    async fn model_catalog(
        &self,
        provider: &str,
        refresh: bool,
    ) -> Result<MobileModelCatalog, String> {
        self.note("modelCatalog", json!([provider, refresh]));
        Ok(serde_json::from_value(if provider == "anthropic" {
            json!({"provider": provider, "status": "ok", "models": [
                {"modelId": "sonnet", "name": "Sonnet"}, {"modelId": "opus", "name": "Opus"}
            ]})
        } else { json!({"provider": provider, "status": "unavailable", "message": "agent did not answer", "models": []}) }).expect("models"))
    }
    async fn describe_device(&self, id: &str) -> Result<MobileDeviceRecord, String> {
        self.note("describeDevice", json!([id]));
        Ok(serde_json::from_value(json!({"projects": if self.config["wide"] == true { json!([]) }
            else { json!([{"projectId": "p1", "name": "Praxis"}]) }, "hostName": "Mac", "accessMode": "local-only"})).expect("device"))
    }
    async fn list_projects(&self) -> Result<Vec<MobileProjectSummary>, String> {
        self.note("listProjects", json!([]));
        Ok(vec![MobileProjectSummary {
            project_id: "p1".into(),
            name: "Praxis".into(),
            workflow: None,
        }])
    }
    async fn get_project(&self, id: &str) -> Result<Option<MobileProjectSummary>, String> {
        self.note("getProject", json!([id]));
        Ok((id == "p1").then(|| MobileProjectSummary {
            project_id: id.into(),
            name: "Praxis".into(),
            workflow: None,
        }))
    }
    async fn list_work(&self, id: &str) -> Result<Value, String> {
        Ok(self.note("listWork", json!([id])))
    }
    async fn list_sessions(&self, id: Option<&str>) -> Result<Vec<MobileSessionSummary>, String> {
        self.note("listSessions", json!([id]));
        Ok(vec![])
    }
    async fn get_session(&self, id: &str) -> Result<Option<MobileSessionSnapshot>, String> {
        self.note("getSession", json!([id]));
        Ok((id == "s1").then(|| self.snapshot()))
    }
    async fn list_workflows(&self, id: &str) -> Result<Value, String> {
        Ok(self.note("listWorkflows", json!([id])))
    }
    async fn list_runs(&self, id: &str) -> Result<Value, String> {
        Ok(self.note("listRuns", json!([id])))
    }
    async fn get_run(&self, id: &str) -> Result<Option<Value>, String> {
        self.note("getRun", json!([id]));
        Ok((id == "r1").then(|| json!({"runId": id, "projectId": "p1"})))
    }
    async fn list_run_changes(&self, id: &str) -> Result<Value, String> {
        Ok(self.note("listRunChanges", json!([id])))
    }
    async fn session_changes(&self, id: &str) -> Result<Value, String> {
        Ok(self.note("sessionChanges", json!([id])))
    }
    async fn session_file_diff(&self, id: &str, path: &str) -> Result<Value, String> {
        Ok(self.note("sessionFileDiff", json!([id, path])))
    }
    async fn session_image_preview(
        &self,
        id: &str,
        params: MobileImagePreviewParams,
    ) -> Result<Option<Value>, String> {
        self.note("sessionImagePreview", json!([id, params]));
        Ok(None)
    }
    fn find_gadget(&self, id: &str, gadget_id: &str) -> Option<Value> {
        self.note("findGadget", json!([id, gadget_id]));
        if self.config["noGadget"] == true {
            return None;
        }
        let mut gadget = vectors()["gadget"].clone();
        if self.config["approval"] == true {
            gadget["kind"] = json!("approval");
            gadget["actions"] = json!([{"actionId": "answer", "effect": "approval"}]);
        }
        Some(gadget)
    }
    async fn submit_gadget(
        &self,
        id: &str,
        payload: MobileGadgetSubmitPayload,
        actor: &str,
    ) -> Result<Value, String> {
        self.note("submitGadget", json!([id, payload, actor]));
        Ok(
            json!({"status": self.config.get("gadgetStatus").cloned().unwrap_or(json!("completed"))}),
        )
    }
    async fn list_attention(&self, id: &str) -> Result<Value, String> {
        Ok(self.note("listAttention", json!([id])))
    }
    async fn create_session(
        &self,
        input: MobileCreateSession,
    ) -> Result<MobileSessionSnapshot, String> {
        self.note("createSession", json!([input]));
        Ok(self.snapshot())
    }
    async fn start_run(&self, input: MobileStartRun) -> Result<Value, String> {
        let result = self.note("startRun", json!([input]));
        match self.config["startError"].as_str() {
            Some(error) => Err(error.into()),
            None => Ok(result),
        }
    }
    async fn cancel_run(
        &self,
        id: &str,
        reason: Option<&str>,
        actor: &str,
    ) -> Result<Value, String> {
        Ok(self.note("cancelRun", json!([id, reason, actor])))
    }
    async fn retry_stage(&self, id: &str, node: &str, actor: &str) -> Result<Value, String> {
        Ok(self.note("retryStage", json!([id, node, actor])))
    }
    async fn approve_run(
        &self,
        id: &str,
        actor: &str,
        note: Option<&str>,
    ) -> Result<Value, String> {
        Ok(self.note("approveRun", json!([id, actor, note])))
    }
    async fn reject_run(&self, id: &str, actor: &str, reason: &str) -> Result<Value, String> {
        Ok(self.note("rejectRun", json!([id, actor, reason])))
    }
    async fn continue_session(
        &self,
        id: &str,
        message: &str,
        actor: &str,
    ) -> Result<Value, String> {
        Ok(self.note("continueSession", json!([id, message, actor])))
    }
    async fn configure_session(
        &self,
        id: &str,
        change: MobileSessionRuntimeChange,
        actor: &str,
    ) -> Result<MobileSessionSnapshot, String> {
        self.note("configureSession", json!([id, change, actor]));
        Ok(self.snapshot())
    }
    async fn cancel_session(&self, id: &str, actor: &str) -> Result<Value, String> {
        Ok(self.note("cancelSession", json!([id, actor])))
    }
    async fn respond_to_permission(
        &self,
        id: &str,
        decision: MobilePermissionAnswer,
        actor: &str,
        project: &str,
    ) -> Result<Value, String> {
        Ok(self.note("respondToPermission", json!([id, decision, actor, project])))
    }
}

use super::super::scheduled_runs::MobileScheduledRun;

#[async_trait]
impl MobileSchedules for Arc<Deps> {
    async fn list(&self, project: &str) -> Result<Vec<MobileScheduledRun>, String> {
        self.note("schedules.list", json!([project]));
        Ok(vec![self.schedule()])
    }
    async fn save(
        &self,
        project: &str,
        input: MobileScheduleInput,
    ) -> Result<MobileScheduledRun, String> {
        self.note("schedules.save", json!([project, input]));
        Ok(self.schedule())
    }
    async fn set_armed(
        &self,
        project: &str,
        id: &str,
        armed: bool,
    ) -> Result<MobileScheduledRun, String> {
        self.note("schedules.setArmed", json!([project, id, armed]));
        Ok(self.schedule())
    }
    async fn resolve_missed(
        &self,
        project: &str,
        id: &str,
        resolution: MissedResolution,
    ) -> Result<MobileScheduledRun, String> {
        let resolution = match resolution {
            MissedResolution::StartNow => "start-now",
            MissedResolution::Skip => "skip",
        };
        self.note("schedules.resolveMissed", json!([project, id, resolution]));
        Ok(self.schedule())
    }
}

#[tokio::test]
async fn host_service_results_errors_and_side_effects_match_typescript() {
    let vectors = vectors();
    let mut failures = vec![];
    for case in vectors["cases"].as_array().expect("cases") {
        let recorder = Arc::new(Deps {
            config: case["config"].clone(),
            calls: Mutex::new(vec![]),
        });
        let deps: SharedDeps = Arc::new(recorder.clone());
        let commands = create_mobile_host_execution_handlers(deps.clone());
        let result = if case["kind"] == "read" {
            let reads = create_mobile_host_reads(deps, commands.keys().copied().collect());
            let request: MobileReadRequest =
                serde_json::from_value(case["request"].clone()).expect("read");
            reads[&request.operation](request).await
        } else {
            let request: MobileCommand =
                serde_json::from_value(case["request"].clone()).expect("command");
            commands[&request.operation](request).await
        };
        let actual = match result {
            Ok(value) => json!({"value": value}),
            Err(error) => json!({"error": error.0}),
        };
        let calls = json!(*recorder.calls.lock().expect("calls"));
        if actual != case["expected"] || calls != case["calls"] {
            failures.push(format!(
                "{}\nresult: {actual}\nexpected: {}\ncalls: {calls}\nexpected calls: {}",
                case["name"], case["expected"], case["calls"]
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} parity failures:\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}

#[test]
fn json_values_use_javascript_string_coercion_for_payloads() {
    assert_eq!(js_string(&json!(null)), "null");
    assert_eq!(js_string(&json!({"a": 1})), "[object Object]");
    assert_eq!(js_string(&json!([1, "two", false])), "1,two,false");
}

#[test]
fn parity_vectors_cover_every_operation() {
    let vectors = vectors();
    for operation in MobileReadOperation::ALL
        .iter()
        .map(|op| op.as_str())
        .chain(MobileCommandOperation::ALL.iter().map(|op| op.as_str()))
    {
        assert!(
            vectors["cases"]
                .as_array()
                .expect("cases")
                .iter()
                .any(|case| case["request"]["operation"] == operation),
            "missing {operation}"
        );
    }
}

#[tokio::test]
async fn application_checks_capabilities_and_replays_schedule_mutations_once() {
    use super::super::application::{
        MobileHostApplication, default_payload_digest, handle_mobile_command, handle_mobile_read,
    };
    use super::super::ledger::InMemoryMobileCommandLedger;
    let recorder = Arc::new(Deps {
        config: json!({"schedules": true}),
        calls: Mutex::new(vec![]),
    });
    let deps: SharedDeps = Arc::new(recorder.clone());
    let commands = create_mobile_host_execution_handlers(deps.clone());
    let app = MobileHostApplication {
        reads: create_mobile_host_reads(deps, commands.keys().copied().collect()),
        commands,
        ledger: Arc::new(InMemoryMobileCommandLedger::default()),
        payload_digest: default_payload_digest(),
    };
    let fixtures = vectors();
    let cases = fixtures["cases"].as_array().expect("cases");
    let request = cases
        .iter()
        .find(|case| case["request"]["operation"] == "scheduledRuns.save")
        .expect("schedule")["request"]
        .clone();
    let command: MobileCommand = serde_json::from_value(request.clone()).expect("command");
    let first = handle_mobile_command(&app, command.clone())
        .await
        .expect("save");
    assert_eq!(
        handle_mobile_command(&app, command.clone())
            .await
            .expect("replay"),
        first
    );
    assert_eq!(recorder.calls.lock().expect("calls").len(), 1, "one save");
    let mut changed = command;
    changed.payload["name"] = json!("Changed");
    assert!(handle_mobile_command(&app, changed).await.is_err());
    for case in cases.iter().filter(|case| case["kind"] == "command") {
        let mut request = case["request"].clone();
        request["caller"]["capabilities"] = json!(["view"]);
        let request: MobileCommand = serde_json::from_value(request).expect("command");
        assert!(
            handle_mobile_command(&app, request).await.is_err(),
            "view-only {}",
            case["name"]
        );
    }
    let mut request = cases
        .iter()
        .find(|case| case["kind"] == "read")
        .expect("read")["request"]
        .clone();
    request["caller"]["capabilities"] = json!(["execute"]);
    assert!(
        handle_mobile_read(&app, serde_json::from_value(request).expect("read"))
            .await
            .is_err()
    );
    assert_eq!(
        recorder.calls.lock().expect("calls").len(),
        1,
        "denied requests have no service side effects"
    );
}
