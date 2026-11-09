//! First opt-in workflow read: policy listing from the existing desktop store.
//!
//! This deliberately mirrors the TypeScript store's permissive list guard, retaining unknown
//! fields rather than deserializing through the stricter execution-time policy struct. The
//! desktop still owns writes; this handler never creates or updates the store.

use praxis_contracts::RustRpcError;
use serde_json::{Value, json};

use crate::HostContext;

const POLICIES_KEY: &str = "praxis.workflowPolicies.v1";

pub(crate) fn register_workflow_read_handlers(ctx: &HostContext) {
    ctx.register_handler("workflows:listPolicies", |ctx, _args| {
        let file = ctx.config().user_data_dir.join("workflows.json");
        let document = std::fs::read_to_string(file)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .unwrap_or_else(|| json!({}));
        list_policies(&document)
    });
}

fn list_policies(document: &Value) -> Result<Value, RustRpcError> {
    // JsonKeyValueStore accepts a JSON null on load; its subsequent property access throws.
    if document.is_null() {
        return Err(RustRpcError {
            code: "WORKFLOW_STORE_READ_ERROR".into(),
            message: format!("Cannot read properties of null (reading '{POLICIES_KEY}')"),
        });
    }
    let policies = document.get(POLICIES_KEY).and_then(Value::as_array);
    Ok(Value::Array(
        policies
            .into_iter()
            .flatten()
            .filter(|value| {
                value.get("id").is_some_and(Value::is_string)
                    && value.get("requiredGates").is_some_and(Value::is_array)
            })
            .cloned()
            .collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_order_sparse_records_and_unknown_fields_using_the_typescript_guard() {
        let first = json!({"id":"", "requiredGates": [null, "future-gate"], "future": {"x": 1}});
        let second = json!({"id":"next", "requiredGates": []});
        let document = json!({POLICIES_KEY: [first.clone(), null, {}, {"id": 1, "requiredGates": []}, second.clone()]});
        assert_eq!(
            list_policies(&document).expect("list"),
            json!([first, second])
        );
    }

    #[test]
    fn missing_or_non_array_policy_list_is_empty_and_null_root_is_an_error() {
        for document in [json!({}), json!({POLICIES_KEY: {}}), json!([]), json!(3)] {
            assert_eq!(list_policies(&document).expect("empty list"), json!([]));
        }
        assert!(list_policies(&Value::Null).is_err());
    }
}
