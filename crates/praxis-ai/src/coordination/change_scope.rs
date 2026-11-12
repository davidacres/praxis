//! Changes outside what a session declared (FX-BE-094 / TASK-265).
//!
//! A session that claimed specific files or folders has said what it is working on. A change
//! anywhere else is either a mistake or something nobody agreed to, and with several sessions in
//! flight possibly a collision with another session's work. Policy decides what happens:
//! `Escalate` lets the change set stand but flags it for a person; `Block` holds it back from
//! commit and merge until a person approves it. A session that declared nothing (or a coarse
//! worktree claim) has no narrower scope to be outside of.

use super::policy::canonical_path;
use super::types::Resource;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutOfScopePolicy {
    Block,
    Escalate,
}

/// What the policy asks for: nothing to do, a flag for a person, or a hold.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScopeAction {
    None,
    Escalate,
    Block,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangeScopeAssessment {
    /// The session declared a narrower scope than its whole worktree.
    pub scoped: bool,
    pub in_scope: Vec<String>,
    pub out_of_scope: Vec<String>,
    pub action: ScopeAction,
    pub message: Option<String>,
}

fn worktree_of(resource: &Resource) -> Option<&str> {
    match resource {
        Resource::File { worktree, .. }
        | Resource::Directory { worktree, .. }
        | Resource::Worktree { worktree }
        | Resource::Checkout { worktree }
        | Resource::GitIndex { worktree } => Some(worktree),
        _ => None,
    }
}

#[must_use]
pub fn assess_change_scope(
    changed_paths: &[String],
    declared: &[Resource],
    worktree: &str,
    policy: OutOfScopePolicy,
    case_insensitive: bool,
) -> ChangeScopeAssessment {
    let root = canonical_path(worktree, false);
    let mine: Vec<&Resource> = declared
        .iter()
        .filter(|resource| worktree_of(resource).is_some_and(|w| canonical_path(w, false) == root))
        .collect();
    let coarse = mine
        .iter()
        .any(|r| matches!(r, Resource::Worktree { .. } | Resource::Checkout { .. }));
    // (is a file, canonical path)
    let narrow: Vec<(bool, String)> = mine
        .iter()
        .filter_map(|r| match r {
            Resource::File { path, .. } => Some((true, canonical_path(path, case_insensitive))),
            Resource::Directory { path, .. } => {
                Some((false, canonical_path(path, case_insensitive)))
            }
            _ => None,
        })
        .collect();
    let mut paths: Vec<String> = Vec::new();
    for changed in changed_paths {
        let canonical = canonical_path(changed, case_insensitive);
        if !canonical.is_empty() && !paths.contains(&canonical) {
            paths.push(canonical);
        }
    }
    if coarse || narrow.is_empty() {
        return ChangeScopeAssessment {
            scoped: false,
            in_scope: paths,
            out_of_scope: Vec::new(),
            action: ScopeAction::None,
            message: None,
        };
    }

    let covers = |changed: &str| {
        narrow.iter().any(|(is_file, target)| {
            if *is_file {
                changed == target
            } else {
                target.is_empty()
                    || changed == target
                    || changed
                        .strip_prefix(target.as_str())
                        .is_some_and(|rest| rest.starts_with('/'))
            }
        })
    };
    let (in_scope, out_of_scope): (Vec<String>, Vec<String>) =
        paths.into_iter().partition(|p| covers(p));
    if out_of_scope.is_empty() {
        return ChangeScopeAssessment {
            scoped: true,
            in_scope,
            out_of_scope,
            action: ScopeAction::None,
            message: None,
        };
    }
    let count = out_of_scope.len();
    let mut list = out_of_scope
        .iter()
        .take(10)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    if count > 10 {
        list.push_str(&format!(", and {} more", count - 10));
    }
    let plural = if count == 1 { "" } else { "s" };
    let (action, message) = match policy {
        OutOfScopePolicy::Block => (
            ScopeAction::Block,
            format!(
                "Held back: {count} changed path{plural} outside what this session claimed ({list}). Approve them, or undo them, before this change set is committed or merged."
            ),
        ),
        OutOfScopePolicy::Escalate => (
            ScopeAction::Escalate,
            format!(
                "{count} changed path{plural} outside what this session claimed ({list}). Check they belong in this change."
            ),
        ),
    };
    ChangeScopeAssessment {
        scoped: true,
        in_scope,
        out_of_scope,
        action,
        message: Some(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(path: &str) -> Resource {
        Resource::Directory {
            worktree: "/repo".into(),
            path: path.into(),
        }
    }

    fn paths(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn nothing_declared_means_nothing_to_be_outside_of() {
        let assessment = assess_change_scope(
            &paths(&["a.ts"]),
            &[],
            "/repo",
            OutOfScopePolicy::Block,
            false,
        );
        assert!(!assessment.scoped);
        assert_eq!(assessment.action, ScopeAction::None);
        assert_eq!(assessment.in_scope, paths(&["a.ts"]));
    }

    #[test]
    fn a_coarse_worktree_claim_is_not_a_narrower_scope() {
        let declared = [
            dir("src"),
            Resource::Worktree {
                worktree: "/repo".into(),
            },
        ];
        let assessment = assess_change_scope(
            &paths(&["docs/x.md"]),
            &declared,
            "/repo",
            OutOfScopePolicy::Block,
            false,
        );
        assert!(!assessment.scoped);
        assert!(assessment.out_of_scope.is_empty());
    }

    #[test]
    fn files_and_directories_cover_themselves_and_what_is_beneath() {
        let declared = [
            dir("src/auth"),
            Resource::File {
                worktree: "/repo".into(),
                path: "package.json".into(),
            },
        ];
        let assessment = assess_change_scope(
            &paths(&[
                "src/auth/login.ts",
                "./src/auth/deep/x.ts",
                "package.json",
                "src/authority.ts",
                "src/auth.ts",
                "package.json/inner",
                "src/auth/login.ts",
            ]),
            &declared,
            "/repo",
            OutOfScopePolicy::Escalate,
            false,
        );
        assert!(assessment.scoped);
        assert_eq!(
            assessment.in_scope,
            paths(&["src/auth/login.ts", "src/auth/deep/x.ts", "package.json"])
        );
        assert_eq!(
            assessment.out_of_scope,
            paths(&["src/authority.ts", "src/auth.ts", "package.json/inner"])
        );
        assert_eq!(assessment.action, ScopeAction::Escalate);
        assert!(
            assessment
                .message
                .as_deref()
                .is_some_and(|m| m.starts_with("3 changed paths outside what this session claimed"))
        );
    }

    #[test]
    fn block_holds_the_change_back_and_says_so() {
        let assessment = assess_change_scope(
            &paths(&["src/auth/a.ts", "package.json"]),
            &[dir("src/auth")],
            "/repo/",
            OutOfScopePolicy::Block,
            false,
        );
        assert_eq!(assessment.action, ScopeAction::Block);
        assert_eq!(assessment.out_of_scope, paths(&["package.json"]));
        assert_eq!(
            assessment.message.as_deref(),
            Some(
                "Held back: 1 changed path outside what this session claimed (package.json). Approve them, or undo them, before this change set is committed or merged."
            )
        );
    }

    #[test]
    fn a_claim_in_another_worktree_does_not_count() {
        let declared = [Resource::Directory {
            worktree: "/elsewhere".into(),
            path: "src".into(),
        }];
        let assessment = assess_change_scope(
            &paths(&["docs/a.md"]),
            &declared,
            "/repo",
            OutOfScopePolicy::Block,
            false,
        );
        assert!(!assessment.scoped);
    }

    #[test]
    fn the_list_is_capped_at_ten_paths() {
        let many: Vec<String> = (0..13).map(|n| format!("other/{n}.ts")).collect();
        let assessment = assess_change_scope(
            &many,
            &[dir("src")],
            "/repo",
            OutOfScopePolicy::Escalate,
            false,
        );
        let message = assessment.message.expect("message");
        assert!(message.contains("other/9.ts, and 3 more"));
        assert!(!message.contains("other/10.ts"));
    }

    #[test]
    fn case_insensitive_filesystems_compare_folded() {
        let assessment = assess_change_scope(
            &paths(&["SRC/Auth/Login.ts"]),
            &[dir("src/auth")],
            "/repo",
            OutOfScopePolicy::Block,
            true,
        );
        assert_eq!(assessment.action, ScopeAction::None);
    }

    #[test]
    fn a_root_directory_claim_covers_everything() {
        let assessment = assess_change_scope(
            &paths(&["anything/at/all.ts"]),
            &[dir("")],
            "/repo",
            OutOfScopePolicy::Block,
            false,
        );
        assert!(assessment.scoped);
        assert_eq!(assessment.action, ScopeAction::None);
    }
}
