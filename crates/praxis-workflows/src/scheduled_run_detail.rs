//! The order the scheduled-run screens show a workflow's agent tasks in
//! (`scheduledRunDetail.ts` port).
//!
//! The stages a person would recognise as the ticket's agent tasks, in the order they run: a
//! topological order over the workflow's forward edges, ties broken by the designer's layout (top to
//! bottom, then left to right). A join is plumbing and is left out. A stage reached only through a
//! failure edge (a repair step) appears only once it has actually run.
//!
//! Pure: the caller passes the definition and says which stages ran.

use crate::edges::dag_edges;
use crate::types::{WorkflowDefinition, WorkflowEdgeOutcome, WorkflowNode};

/// The stages of a workflow in the order they run, without the joins and without a repair step that
/// has not run.
#[must_use]
pub fn ordered_workflow_stages(
    definition: &WorkflowDefinition,
    ran: impl Fn(&str) -> bool,
) -> Vec<&WorkflowNode> {
    let edges: Vec<_> = dag_edges(definition).collect();
    let mut incoming: Vec<(String, usize)> = definition
        .nodes
        .iter()
        .map(|node| (node.base().id.clone(), 0usize))
        .collect();
    for edge in &edges {
        if let Some(count) = incoming
            .iter_mut()
            .find(|(id, _)| id == &edge.to)
            .map(|(_, count)| count)
        {
            *count += 1;
        }
    }
    let by_id: Vec<&WorkflowNode> = definition.nodes.iter().collect();

    // The entry node first, then the designer's layout: top to bottom, then left to right.
    let compare = |left: &&WorkflowNode, right: &&WorkflowNode| -> std::cmp::Ordering {
        if left.base().id == definition.entry_node_id {
            return std::cmp::Ordering::Less;
        }
        if right.base().id == definition.entry_node_id {
            return std::cmp::Ordering::Greater;
        }
        left.base()
            .y
            .partial_cmp(&right.base().y)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(
                left.base()
                    .x
                    .partial_cmp(&right.base().x)
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
    };

    let mut ready: Vec<&WorkflowNode> = definition
        .nodes
        .iter()
        .filter(|node| {
            incoming
                .iter()
                .find(|(id, _)| id == &node.base().id)
                .is_some_and(|(_, count)| *count == 0)
        })
        .collect();
    ready.sort_by(compare);

    let mut order: Vec<&WorkflowNode> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    while !ready.is_empty() {
        let node = ready.remove(0);
        if seen.contains(&node.base().id) {
            continue;
        }
        seen.push(node.base().id.clone());
        order.push(node);
        for edge in edges.iter().filter(|edge| edge.from == node.base().id) {
            let Some((_, count)) = incoming.iter_mut().find(|(id, _)| id == &edge.to) else {
                continue;
            };
            *count = count.saturating_sub(1);
            let left = *count;
            if left == 0 {
                if let Some(target) = by_id.iter().find(|node| node.base().id == edge.to) {
                    ready.push(target);
                    ready.sort_by(compare);
                }
            }
        }
    }
    // A cycle the DAG filter missed would leave nodes out; keep them, at the end.
    for node in &by_id {
        if !seen.contains(&node.base().id) {
            order.push(node);
        }
    }

    let only_on_failure = |node_id: &str| -> bool {
        let into: Vec<_> = edges.iter().filter(|edge| edge.to == node_id).collect();
        !into.is_empty()
            && into
                .iter()
                .all(|edge| edge.on == WorkflowEdgeOutcome::Failure)
    };
    order
        .into_iter()
        .filter(|node| {
            node.type_name() != "join"
                && (!only_on_failure(&node.base().id) || ran(&node.base().id))
        })
        .collect()
}
