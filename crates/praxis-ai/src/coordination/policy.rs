//! Which claims conflict (FX-BF-048 / TASK-391; FX-BE-094 / TASK-263 overlap detection).
//!
//! Two shared claims never conflict. Otherwise two resources conflict when they can be
//! changed by, or depend on, the same thing:
//!
//! - inside one worktree, a checkout operation conflicts with everything; a coarse worktree
//!   claim conflicts with every file and directory claim; a directory conflicts with anything
//!   beneath it; a file with the same file. Different worktrees never conflict.
//! - the index of one worktree is separate from its files: staging does not block edits.
//! - a live app instance, a browser surface, a port, a fixture, a process group: the same one.
//! - the desktop's input is one resource for the whole machine.
//! - build output: the same directory, or one inside the other.

use super::types::{ClaimMode, Resource};

/// A path normalised for comparison: forward slashes, no leading `./`, no trailing slash.
pub fn canonical_path(value: &str, case_insensitive: bool) -> String {
    let mut normal = value.replace('\\', "/");
    // `^\.\/+`: one leading "." with its slashes.
    if let Some(rest) = normal.strip_prefix('.')
        && rest.starts_with('/')
    {
        normal = rest.trim_start_matches('/').to_owned();
    }
    let normal = normal.trim_end_matches('/');
    let mut collapsed = String::with_capacity(normal.len());
    let mut previous_slash = false;
    for ch in normal.chars() {
        if ch == '/' {
            if previous_slash {
                continue;
            }
            previous_slash = true;
        } else {
            previous_slash = false;
        }
        collapsed.push(ch);
    }
    if case_insensitive {
        collapsed.to_lowercase()
    } else {
        collapsed
    }
}

fn within(child: &str, parent: &str) -> bool {
    parent.is_empty()
        || child == parent
        || child
            .strip_prefix(parent)
            .is_some_and(|rest| rest.starts_with('/'))
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

fn path_of(resource: &Resource) -> &str {
    match resource {
        Resource::File { path, .. } | Resource::Directory { path, .. } => path,
        _ => "",
    }
}

/// Whether two resources overlap, whatever the mode.
pub fn resources_overlap(left: &Resource, right: &Resource, case_insensitive: bool) -> bool {
    if let (Some(a), Some(b)) = (worktree_of(left), worktree_of(right)) {
        if canonical_path(a, false) != canonical_path(b, false) {
            return false;
        }
        if matches!(left, Resource::Checkout { .. }) || matches!(right, Resource::Checkout { .. }) {
            return true;
        }
        if matches!(left, Resource::GitIndex { .. }) || matches!(right, Resource::GitIndex { .. }) {
            return std::mem::discriminant(left) == std::mem::discriminant(right);
        }
        if matches!(left, Resource::Worktree { .. }) || matches!(right, Resource::Worktree { .. }) {
            return true;
        }
        let a = canonical_path(path_of(left), case_insensitive);
        let b = canonical_path(path_of(right), case_insensitive);
        return match (left, right) {
            (Resource::File { .. }, Resource::File { .. }) => a == b,
            (Resource::Directory { .. }, Resource::Directory { .. }) => {
                within(&a, &b) || within(&b, &a)
            }
            (Resource::Directory { .. }, _) => within(&b, &a),
            _ => within(&a, &b),
        };
    }
    match (left, right) {
        (Resource::Desktop, Resource::Desktop) => true,
        (Resource::AppUi { instance: a }, Resource::AppUi { instance: b }) => a == b,
        (Resource::Browser { surface: a }, Resource::Browser { surface: b }) => a == b,
        (Resource::Port { port: a }, Resource::Port { port: b }) => a == b,
        (Resource::Fixture { id: a }, Resource::Fixture { id: b }) => a == b,
        (Resource::Process { host: ha, pgid: a }, Resource::Process { host: hb, pgid: b }) => {
            ha == hb && a == b
        }
        (Resource::BuildOutput { dir: a }, Resource::BuildOutput { dir: b }) => {
            let (a, b) = (
                canonical_path(a, case_insensitive),
                canonical_path(b, case_insensitive),
            );
            within(&a, &b) || within(&b, &a)
        }
        _ => false,
    }
}

/// Whether two claims, with their modes, may not be held at once.
pub fn claims_conflict(left: (&Resource, ClaimMode), right: (&Resource, ClaimMode)) -> bool {
    if left.1 == ClaimMode::Shared && right.1 == ClaimMode::Shared {
        return false;
    }
    resources_overlap(left.0, right.0, false)
}

/// A one-line, human description of a resource for a blocker message.
pub fn describe_resource(resource: &Resource) -> String {
    match resource {
        Resource::File { path, .. } => format!("file {path}"),
        Resource::Directory { path, .. } => format!("folder {path}/"),
        Resource::Worktree { worktree } => format!("the checkout at {worktree}"),
        Resource::Checkout { worktree } => format!("branch operations in {worktree}"),
        Resource::GitIndex { worktree } => format!("the Git index of {worktree}"),
        Resource::AppUi { instance } => format!("the live app ({instance})"),
        Resource::Browser { surface } => format!("the in-app browser ({surface})"),
        Resource::Desktop => "the desktop (mouse and keyboard)".to_owned(),
        Resource::BuildOutput { dir } => format!("build output {dir}"),
        Resource::Port { port } => format!("port {port}"),
        Resource::Fixture { id } => format!("fixture {id}"),
        Resource::Process { pgid, .. } => format!("process group {pgid}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(worktree: &str, path: &str) -> Resource {
        Resource::File {
            worktree: worktree.into(),
            path: path.into(),
        }
    }
    fn dir(worktree: &str, path: &str) -> Resource {
        Resource::Directory {
            worktree: worktree.into(),
            path: path.into(),
        }
    }
    fn overlap(a: &Resource, b: &Resource) -> bool {
        resources_overlap(a, b, false)
    }

    #[test]
    fn paths_are_compared_in_canonical_form() {
        assert_eq!(canonical_path(".//src\\a//b/", false), "src/a/b");
        assert_eq!(canonical_path("./", false), "");
        assert_eq!(canonical_path("Src/A", true), "src/a");
        assert!(overlap(&file("/r", "src/a.rs"), &file("/r/", "./src/a.rs")));
    }

    #[test]
    fn files_and_folders_overlap_by_containment() {
        assert!(overlap(&dir("/r", "src"), &file("/r", "src/a.rs")));
        assert!(overlap(&file("/r", "src/a.rs"), &dir("/r", "src")));
        assert!(!overlap(&dir("/r", "src"), &file("/r", "srcs/a.rs")));
        assert!(overlap(&dir("/r", ""), &file("/r", "anything")));
        assert!(overlap(&dir("/r", "a"), &dir("/r", "a/b")));
        assert!(!overlap(&file("/r", "a.rs"), &file("/r", "b.rs")));
    }

    #[test]
    fn different_worktrees_never_conflict() {
        assert!(!overlap(&file("/one", "a.rs"), &file("/two", "a.rs")));
        assert!(!overlap(
            &Resource::Checkout {
                worktree: "/one".into()
            },
            &Resource::Worktree {
                worktree: "/two".into()
            }
        ));
    }

    #[test]
    fn checkout_and_worktree_cover_everything_but_the_index_is_separate() {
        let checkout = Resource::Checkout {
            worktree: "/r".into(),
        };
        let worktree = Resource::Worktree {
            worktree: "/r".into(),
        };
        let index = Resource::GitIndex {
            worktree: "/r".into(),
        };
        assert!(overlap(&checkout, &file("/r", "a")));
        assert!(overlap(&worktree, &dir("/r", "a")));
        assert!(!overlap(&index, &file("/r", "a")));
        assert!(!overlap(&worktree, &index));
        assert!(overlap(&checkout, &index));
        assert!(overlap(
            &index,
            &Resource::GitIndex {
                worktree: "/r".into()
            }
        ));
    }

    #[test]
    fn single_instance_resources_match_on_identity() {
        assert!(overlap(&Resource::Desktop, &Resource::Desktop));
        assert!(overlap(
            &Resource::Port { port: 80 },
            &Resource::Port { port: 80 }
        ));
        assert!(!overlap(
            &Resource::Port { port: 80 },
            &Resource::Port { port: 81 }
        ));
        assert!(!overlap(
            &Resource::Browser {
                surface: "a".into()
            },
            &Resource::AppUi {
                instance: "a".into()
            }
        ));
        assert!(overlap(
            &Resource::Process {
                host: "h".into(),
                pgid: 5
            },
            &Resource::Process {
                host: "h".into(),
                pgid: 5
            }
        ));
        assert!(!overlap(
            &Resource::Process {
                host: "h".into(),
                pgid: 5
            },
            &Resource::Process {
                host: "g".into(),
                pgid: 5
            }
        ));
        assert!(overlap(
            &Resource::BuildOutput { dir: "out".into() },
            &Resource::BuildOutput {
                dir: "out/x".into()
            }
        ));
    }

    #[test]
    fn two_shared_claims_never_conflict() {
        let a = file("/r", "a");
        assert!(!claims_conflict(
            (&a, ClaimMode::Shared),
            (&a, ClaimMode::Shared)
        ));
        assert!(claims_conflict(
            (&a, ClaimMode::Shared),
            (&a, ClaimMode::Exclusive)
        ));
    }

    #[test]
    fn resources_are_described_for_a_blocker_message() {
        assert_eq!(describe_resource(&file("/r", "sum.js")), "file sum.js");
        assert_eq!(describe_resource(&dir("/r", "src")), "folder src/");
        assert_eq!(
            describe_resource(&Resource::Process {
                host: "h".into(),
                pgid: 42
            }),
            "process group 42"
        );
    }
}
