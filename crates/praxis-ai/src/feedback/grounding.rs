//! Workspace grounding (port of `workspaceGrounding.ts`): ranks the host's raw workspace facts
//! against a prompt so fix chips name real files and real test commands.

use std::collections::BTreeSet;
use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

use super::types::{Message, PriorContext, Symbol, WorkspaceHints, bounded_messages, locale_cmp};

#[derive(Debug, Clone)]
pub struct RankedFile {
    pub path: String,
    pub score: usize,
}

#[derive(Debug, Clone)]
pub struct TestCommand {
    pub label: String,
    pub command: String,
}

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("static pattern"))
}

const STOPWORDS: &[&str] = &[
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "into",
    "when",
    "then",
    "than",
    "are",
    "was",
    "can",
    "you",
    "please",
    "make",
    "should",
    "would",
    "could",
    "have",
    "has",
    "not",
    "but",
    "all",
    "add",
    "fix",
    "update",
    "change",
    "use",
    "new",
    "its",
    "our",
    "out",
    "any",
    "get",
    "set",
    "run",
    "tsx",
    "jsx",
    "src",
    "test",
    "tests",
    "spec",
    "file",
    "files",
    "index",
    "main",
    "app",
    "lib",
    "put",
    "move",
    "rename",
    "remove",
    "delete",
    "create",
    "show",
    "hide",
    "bigger",
    "smaller",
    "larger",
    "better",
    "faster",
    "slower",
    "simpler",
    "cleaner",
    "nicer",
    "properly",
    "correctly",
];

pub fn basename(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

fn singular(word: &str) -> String {
    if word.ends_with('s') && word.chars().count() > 4 {
        word[..word.len() - 1].to_owned()
    } else {
        word.to_owned()
    }
}

fn prompt_terms(text: &str) -> BTreeSet<String> {
    static WORD: OnceLock<Regex> = OnceLock::new();
    let lower = text.to_lowercase();
    re(&WORD, r"[a-z][a-z0-9]{2,}")
        .find_iter(&lower)
        .map(|m| m.as_str())
        .filter(|w| !STOPWORDS.contains(w))
        .map(singular)
        .collect()
}

fn file_terms(path: &str) -> Vec<String> {
    static SPEC: OnceLock<Regex> = OnceLock::new();
    static EXT: OnceLock<Regex> = OnceLock::new();
    static CAMEL: OnceLock<Regex> = OnceLock::new();
    let name = basename(path);
    let stem = re(&SPEC, r"(?i)\.(?:spec|test)\.[a-z]+$").replace(name, "");
    let stem = re(&EXT, r"(?i)\.[a-z0-9]+$")
        .replace(&stem, "")
        .into_owned();
    let spaced = re(&CAMEL, r"([a-z0-9])([A-Z])")
        .replace_all(&stem, "$1 $2")
        .into_owned();
    spaced
        .split(|c: char| !c.is_ascii_alphanumeric())
        .map(str::to_lowercase)
        .filter(|p| p.chars().count() >= 3 && !STOPWORDS.contains(&p.as_str()))
        .map(|p| singular(&p))
        .collect()
}

fn overlap(terms: &BTreeSet<String>, path: &str) -> usize {
    file_terms(path)
        .iter()
        .filter(|t| terms.contains(*t))
        .count()
}

pub fn prompt_mentions_file(prompt: &str, path: &str) -> bool {
    let lower = prompt.to_lowercase();
    lower.contains(&basename(path).to_lowercase()) || lower.contains(&path.to_lowercase())
}

fn is_test_path(path: &str) -> bool {
    static TEST: OnceLock<Regex> = OnceLock::new();
    re(&TEST, r"(?i)\.(?:spec|test)\.[a-z]+$").is_match(path)
}

fn vocabulary(files: &[String]) -> BTreeSet<String> {
    files
        .iter()
        .flat_map(|file| file.split('/').flat_map(file_terms).collect::<Vec<_>>())
        .collect()
}

pub fn rank_file_candidates(
    prompt: &str,
    hints: Option<&WorkspaceHints>,
    limit: usize,
) -> Vec<RankedFile> {
    let Some(hints) = hints else {
        return Vec::new();
    };
    let terms = prompt_terms(prompt);
    if terms.is_empty() {
        return Vec::new();
    }
    let changed: BTreeSet<&String> = hints.changed_files.iter().collect();
    let grounded = if hints.tracked_files.is_empty() {
        terms.len()
    } else {
        let vocab = vocabulary(&hints.tracked_files);
        terms.iter().filter(|t| vocab.contains(*t)).count()
    };
    let unchanged_minimum = grounded.clamp(1, 2);
    let mut seen = BTreeSet::new();
    let mut ranked: Vec<RankedFile> = hints
        .changed_files
        .iter()
        .chain(hints.tracked_files.iter())
        .filter(|f| seen.insert((*f).clone()))
        .filter(|f| !is_test_path(f) && !prompt_mentions_file(prompt, f))
        .map(|path| RankedFile {
            path: path.clone(),
            score: overlap(&terms, path),
        })
        .filter(|c| {
            c.score
                >= if changed.contains(&c.path) {
                    1
                } else {
                    unchanged_minimum
                }
        })
        .collect();
    ranked.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| changed.contains(&b.path).cmp(&changed.contains(&a.path)))
            .then_with(|| {
                a.path
                    .encode_utf16()
                    .count()
                    .cmp(&b.path.encode_utf16().count())
            })
            .then_with(|| locale_cmp(&a.path, &b.path))
    });
    ranked.truncate(limit);
    ranked
}

fn identifier_patterns() -> &'static [Regex; 3] {
    static CELL: OnceLock<[Regex; 3]> = OnceLock::new();
    CELL.get_or_init(|| {
        [
            Regex::new(r"\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b").expect("camel"),
            Regex::new(r"\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b").expect("pascal"),
            Regex::new(r"\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b").expect("snake"),
        ]
    })
}

/// Code identifiers the prompt names, sorted — the words worth an exact lookup in the code index.
pub fn extract_prompt_identifiers(prompt: &str) -> Vec<String> {
    static TICKED: OnceLock<Regex> = OnceLock::new();
    let mut names = BTreeSet::new();
    for pattern in identifier_patterns() {
        for m in pattern.find_iter(prompt) {
            names.insert(m.as_str().to_owned());
        }
    }
    for c in re(&TICKED, r"`([A-Za-z_$][\w$]{2,80})`").captures_iter(prompt) {
        names.insert(c[1].to_owned());
    }
    names.into_iter().collect()
}

fn is_introduced_name(prompt: &str, name: &str) -> bool {
    let pattern = format!(
        r"(?i)\b(?:to|as|into|called|named|new|create|add|introduce|extract)\s+(?:an?\s+|the\s+)?`?{}\b",
        regex::escape(name)
    );
    Regex::new(&pattern).is_ok_and(|r| r.is_match(prompt))
}

pub fn unknown_identifiers(hints: Option<&WorkspaceHints>, prompt: &str) -> Vec<String> {
    static EXT: OnceLock<Regex> = OnceLock::new();
    static SPEC: OnceLock<Regex> = OnceLock::new();
    let Some(hints) = hints else {
        return Vec::new();
    };
    let stems: BTreeSet<String> = hints
        .tracked_files
        .iter()
        .map(|f| {
            let stem = re(&EXT, r"\.[^.]+$").replace(basename(f), "").into_owned();
            re(&SPEC, r"\.(?:spec|test)$")
                .replace(&stem, "")
                .into_owned()
        })
        .collect();
    let mut names: Vec<String> = hints
        .symbols
        .iter()
        .filter(|s: &&Symbol| {
            !s.found && !stems.contains(&s.name) && !is_introduced_name(prompt, &s.name)
        })
        .map(|s| s.name.clone())
        .collect();
    names.sort();
    names
}

fn command_for_test_file(file: &str) -> String {
    static E2E: OnceLock<Regex> = OnceLock::new();
    static SPEC: OnceLock<Regex> = OnceLock::new();
    if re(&E2E, r"(?:^|/)e2e/").is_match(file) || re(&SPEC, r"(?i)\.spec\.[a-z]+$").is_match(file) {
        let relative = match file.find("e2e/") {
            Some(index) if index == 0 || file.as_bytes()[index - 1] == b'/' => &file[index..],
            _ => file,
        };
        return format!("npx playwright test {}", relative.trim_start_matches('/'));
    }
    format!("node --test {file}")
}

pub fn pick_test_command(
    prompt: &str,
    hints: Option<&WorkspaceHints>,
    related: &[String],
) -> Option<TestCommand> {
    let hints = hints?;
    let joined = std::iter::once(prompt.to_owned())
        .chain(related.iter().map(|p| basename(p).to_owned()))
        .collect::<Vec<_>>()
        .join(" ");
    let terms = prompt_terms(&joined);
    let grounded = if hints.tracked_files.is_empty() {
        terms.len()
    } else {
        let vocab = vocabulary(&hints.tracked_files);
        terms.iter().filter(|t| vocab.contains(*t)).count()
    };
    let minimum = grounded.clamp(1, 2);
    let tests: BTreeSet<&String> = hints.test_files.iter().collect();
    let mut best: Vec<(&String, usize)> = tests
        .into_iter()
        .map(|p| (p, overlap(&terms, p)))
        .filter(|(_, s)| *s >= minimum)
        .collect();
    best.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| locale_cmp(a.0, b.0)));
    if let Some((path, _)) = best.first() {
        return Some(TestCommand {
            label: basename(path).to_owned(),
            command: command_for_test_file(path),
        });
    }
    let script = ["check-types", "typecheck", "test", "build"]
        .into_iter()
        .find(|name| hints.package_scripts.iter().any(|s| s == name))?;
    let command = if script == "test" {
        "npm test".to_owned()
    } else {
        format!("npm run {script}")
    };
    Some(TestCommand {
        label: command.clone(),
        command,
    })
}

/// What a new follow-up prompt inherits from a session's earlier turns.
pub fn derive_prior_context(session: &Value) -> PriorContext {
    static ISSUE: OnceLock<Regex> = OnceLock::new();
    let events: Vec<Value> = session["events"].as_array().cloned().unwrap_or_default();
    let goal = session["taskDefinition"]["goal"]
        .as_str()
        .map(str::trim)
        .filter(|g| !g.is_empty());
    let mut messages: Vec<Message> = Vec::new();
    if let Some(goal) = goal {
        messages.push(Message {
            role: "user".into(),
            text: goal.to_owned(),
        });
    }
    for event in &events {
        let kind = event["type"].as_str().unwrap_or_default();
        if kind != "user_input_completed" && kind != "message" {
            continue;
        }
        let text = event["detail"]
            .as_str()
            .filter(|d| !d.is_empty())
            .or_else(|| event["summary"].as_str())
            .unwrap_or_default()
            .trim()
            .to_owned();
        let role = if kind == "message" {
            "assistant"
        } else {
            "user"
        };
        let duplicate = messages
            .last()
            .is_some_and(|p| p.text == text && p.role == role);
        if !text.is_empty() && !duplicate {
            messages.push(Message {
                role: role.into(),
                text,
            });
        }
    }
    let bounded = bounded_messages(Some(&PriorContext {
        recent_messages: Some(messages),
        ..PriorContext::default()
    }));
    let mut touched = BTreeSet::new();
    for event in &events {
        for change in event["data"]["fileChanges"]
            .as_array()
            .into_iter()
            .flatten()
        {
            if let Some(path) = change["path"].as_str().filter(|p| !p.is_empty()) {
                touched.insert(path.to_owned());
            }
        }
    }
    let issue_key = session["issueKey"]
        .as_str()
        .filter(|k| re(&ISSUE, r"^[A-Z]{2,10}(?:-[A-Z]+)?-\d+$").is_match(k))
        .map(str::to_owned);
    let follow_ups = events
        .iter()
        .filter(|e| e["type"] == "user_input_completed")
        .count();
    PriorContext {
        turn_count: follow_ups + usize::from(goal.is_some()),
        touched_paths: touched.into_iter().collect(),
        recent_messages: (!bounded.is_empty()).then_some(bounded),
        issue_key,
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use serde_json::json;

    fn hints() -> WorkspaceHints {
        WorkspaceHints {
            changed_files: vec![
                "src/PromptScoreBar.tsx".into(),
                "src/PromptScoreBarStyles.tsx".into(),
            ],
            test_files: vec!["e2e/promptScoreBar.spec.ts".into()],
            package_scripts: vec!["test".into(), "check-types".into()],
            tracked_files: vec![
                "src/PromptScoreBar.tsx".into(),
                "e2e/promptScoreBar.spec.ts".into(),
            ],
            symbols: Vec::new(),
        }
    }

    #[test]
    fn ranks_matching_files_and_picks_the_spec() {
        let ranked = rank_file_candidates(
            "fix the truncated headline in the prompt score bar",
            Some(&hints()),
            2,
        );
        assert_eq!(ranked[0].path, "src/PromptScoreBar.tsx");
        assert_eq!(ranked[1].path, "src/PromptScoreBarStyles.tsx");
        let test = pick_test_command(
            "fix the prompt score bar",
            Some(&hints()),
            &["src/PromptScoreBar.tsx".into()],
        )
        .unwrap();
        assert_eq!(
            test.command,
            "npx playwright test e2e/promptScoreBar.spec.ts"
        );
    }

    #[test]
    fn falls_back_to_a_package_script() {
        let mut h = hints();
        h.test_files.clear();
        assert_eq!(
            pick_test_command("zzz", Some(&h), &[]).unwrap().command,
            "npm run check-types"
        );
    }

    #[test]
    fn extracts_identifiers_and_flags_unknown_ones() {
        assert_eq!(
            extract_prompt_identifiers("rename fooBar to `baz_qux` in SessionBar"),
            vec!["SessionBar", "baz_qux", "fooBar"]
        );
        let mut h = hints();
        h.symbols = vec![
            Symbol {
                name: "fooBar".into(),
                found: false,
                location: None,
            },
            Symbol {
                name: "newName".into(),
                found: false,
                location: None,
            },
        ];
        assert_eq!(
            unknown_identifiers(Some(&h), "rename fooBar to newName"),
            vec!["fooBar"]
        );
    }

    #[test]
    fn derives_prior_context_from_turns() {
        let session = json!({ "issueKey": "FX-BE-12", "taskDefinition": { "goal": "do it" }, "events": [
            { "type": "message", "detail": "done" },
            { "type": "user_input_completed", "detail": "again" },
            { "type": "tool_complete", "data": { "fileChanges": [{ "path": "a.rs" }] } } ] });
        let ctx = derive_prior_context(&session);
        assert_eq!(ctx.turn_count, 2);
        assert_eq!(ctx.touched_paths, vec!["a.rs"]);
        assert_eq!(ctx.issue_key.as_deref(), Some("FX-BE-12"));
        assert_eq!(ctx.recent_messages.unwrap().len(), 3);
    }
}
