//! Stage session helpers (`workflowStageSession.ts` port): which implementation snapshot a
//! verification stage inspects.

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::edges::dag_edges;
use crate::run::WorkflowRun;

/// The nearest upstream implementation snapshot a stage should inspect.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowImplementationSnapshot {
    #[serde(rename = "ref")]
    pub reference: String,
    pub produced_by_node_id: String,
}

/// The nearest snapshot upstream of `node_id`, breadth-first along DAG edges, so a
/// reviewer sees the one that feeds its branch rather than whichever ran last.
#[must_use]
pub fn find_snapshot(run: &WorkflowRun, node_id: &str) -> Option<WorkflowImplementationSnapshot> {
    // A loop edge is not an inbound branch: walking it would hand a stage the snapshot of
    // work that runs *after* it in the same revision.
    let mut inbound: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for edge in dag_edges(&run.definition) {
        inbound
            .entry(edge.to.as_str())
            .or_default()
            .push(edge.from.as_str());
    }
    let mut seen: HashSet<&str> = HashSet::new();
    let mut frontier: Vec<&str> = inbound.get(node_id).cloned().unwrap_or_default();
    while !frontier.is_empty() {
        let mut next = Vec::new();
        for id in frontier {
            if !seen.insert(id) {
                continue;
            }
            if let Some(reference) = run
                .nodes
                .get(id)
                .and_then(|s| s.snapshot_ref.as_ref())
                .filter(|r| !r.is_empty())
            {
                return Some(WorkflowImplementationSnapshot {
                    reference: reference.clone(),
                    produced_by_node_id: id.to_string(),
                });
            }
            next.extend(inbound.get(id).into_iter().flatten().copied());
        }
        frontier = next;
    }
    None
}
