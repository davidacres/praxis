//! Agents, skills and instruction files that other AI tools keep in a project or the user's
//! home folder (Claude Code, Codex, GitHub Copilot, Gemini / Antigravity, Cursor), discovered
//! in place and never copied. A port of `nativeSources.ts`.
//!
//! Each source records which Praxis runtimes already read it natively (`readBy`): a session on
//! one of those gets nothing extra from Praxis, any other runtime gets the equivalent through
//! Praxis. Project files can arrive with a cloned repository, so they are untrusted until the
//! user approves the project; files in the user's home are theirs and trusted.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use super::catalog::{discover_skills, yaml_scalar};
use super::{fingerprint, front_matter_pair, locale_cmp, resolve};

pub const NATIVE_ECOSYSTEMS: [&str; 6] =
    ["claude", "codex", "agents", "copilot", "gemini", "cursor"];

#[must_use]
pub fn ecosystem_label(ecosystem: &str) -> &'static str {
    match ecosystem {
        "claude" => "Claude Code",
        "codex" => "Codex",
        "agents" => "Shared (.agents)",
        "copilot" => "GitHub Copilot",
        "gemini" => "Gemini / Antigravity",
        "cursor" => "Cursor",
        _ => "",
    }
}

/// Instruction text Praxis adds to one session, in characters; a larger file is left out.
pub const MAX_INSTRUCTION_CHARS: usize = 24_000;
const MAX_FILE_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, Default)]
pub struct NativeSourceOptions {
    pub project_root: Option<PathBuf>,
    pub home_dir: PathBuf,
    /// Ecosystems explicitly switched on or off; a missing one is read.
    pub enabled: BTreeMap<String, bool>,
    pub project_approved: bool,
    pub extra_skill_paths: Vec<PathBuf>,
    pub extra_agent_paths: Vec<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct NativeInstructionFile {
    pub ecosystem: &'static str,
    pub scope: &'static str,
    pub path: PathBuf,
    pub read_by: &'static [&'static str],
    pub display_path: String,
    pub bytes: usize,
    pub fingerprint: String,
    pub content: String,
    pub always_applies: bool,
    pub applies_to: Option<String>,
}

impl NativeInstructionFile {
    /// The snapshot shape: everything but the contents, plus `tooLargeForSessions`.
    #[must_use]
    pub fn to_snapshot_json(&self) -> Value {
        let mut value = json!({
            "ecosystem": self.ecosystem,
            "scope": self.scope,
            "path": self.path.to_string_lossy(),
            "readBy": self.read_by,
            "displayPath": self.display_path,
            "bytes": self.bytes,
            "fingerprint": self.fingerprint,
            "alwaysApplies": self.always_applies,
            "tooLargeForSessions": self.content.chars().count() > MAX_INSTRUCTION_CHARS
        });
        if let Some(applies_to) = &self.applies_to {
            value["appliesTo"] = json!(applies_to);
        }
        value
    }
}

#[derive(Debug, Clone, Default)]
pub struct NativeSourceDiscovery {
    pub project_root: Option<PathBuf>,
    pub instructions: Vec<NativeInstructionFile>,
    /// Profile entries (`{ profile, profilePath, rootPath, ..., source }`).
    pub agents: Vec<Value>,
    /// Skill entries with a `source`.
    pub skills: Vec<Value>,
}

// ── what each tool keeps where ───────────────────────────────────────────

struct Pattern {
    file: Option<&'static str>,
    dir: Option<&'static str>,
    suffix: &'static str,
    read_by: &'static [&'static str],
}

const fn file(file: &'static str, read_by: &'static [&'static str]) -> Pattern {
    Pattern {
        file: Some(file),
        dir: None,
        suffix: "",
        read_by,
    }
}
const fn dir(dir: &'static str, suffix: &'static str, read_by: &'static [&'static str]) -> Pattern {
    Pattern {
        file: None,
        dir: Some(dir),
        suffix,
        read_by,
    }
}

struct Layout {
    project_instructions: Vec<Pattern>,
    user_instructions: Vec<Pattern>,
    agent_project: Option<&'static str>,
    agent_user: Option<&'static str>,
    agent_suffix: &'static str,
    agent_read_by: &'static [&'static str],
    skills_project: &'static [&'static str],
    skills_user: &'static [&'static str],
    skills_read_by: &'static [&'static str],
}

const NONE: &[&str] = &[];

fn layout(ecosystem: &str) -> Layout {
    match ecosystem {
        "claude" => Layout {
            project_instructions: vec![
                file("CLAUDE.md", &["claude-code-cli"]),
                file(".claude/CLAUDE.md", &["claude-code-cli"]),
            ],
            user_instructions: vec![file(".claude/CLAUDE.md", &["claude-code-cli"])],
            agent_project: Some(".claude/agents"),
            agent_user: Some(".claude/agents"),
            agent_suffix: ".md",
            agent_read_by: &["claude-code-cli"],
            skills_project: &[".claude/skills"],
            skills_user: &[".claude/skills"],
            skills_read_by: &["claude-code-cli"],
        },
        "codex" => Layout {
            // AGENTS.md is the cross-tool file: Codex and Copilot both read it.
            project_instructions: vec![file("AGENTS.md", &["codex-cli", "copilot-cli"])],
            user_instructions: vec![file(".codex/AGENTS.md", &["codex-cli"])],
            agent_project: None,
            agent_user: None,
            agent_suffix: ".md",
            agent_read_by: NONE,
            skills_project: &[".codex/skills"],
            skills_user: &[".codex/skills"],
            skills_read_by: &["codex-cli"],
        },
        "agents" => Layout {
            project_instructions: vec![],
            user_instructions: vec![],
            agent_project: None,
            agent_user: None,
            agent_suffix: ".md",
            agent_read_by: NONE,
            skills_project: &[".agents/skills"],
            skills_user: &[".agents/skills"],
            skills_read_by: &["codex-cli", "copilot-cli"],
        },
        "copilot" => Layout {
            project_instructions: vec![
                file(".github/copilot-instructions.md", &["copilot-cli"]),
                dir(".github/instructions", ".instructions.md", &["copilot-cli"]),
            ],
            user_instructions: vec![],
            agent_project: Some(".github/agents"),
            agent_user: Some(".copilot/agents"),
            agent_suffix: ".agent.md",
            agent_read_by: &["copilot-cli"],
            skills_project: &[".github/skills"],
            skills_user: &[".copilot/skills"],
            skills_read_by: &["copilot-cli"],
        },
        "gemini" => Layout {
            project_instructions: vec![file("GEMINI.md", &["antigravity-cli"])],
            user_instructions: vec![file(".gemini/GEMINI.md", &["antigravity-cli"])],
            agent_project: Some(".gemini/agents"),
            agent_user: Some(".gemini/agents"),
            agent_suffix: ".md",
            agent_read_by: &["antigravity-cli"],
            skills_project: &[],
            skills_user: &[],
            skills_read_by: &["antigravity-cli"],
        },
        _ => Layout {
            project_instructions: vec![
                file(".cursorrules", &["cursor-cli"]),
                dir(".cursor/rules", ".mdc", &["cursor-cli"]),
            ],
            user_instructions: vec![],
            agent_project: None,
            agent_user: None,
            agent_suffix: ".md",
            agent_read_by: NONE,
            skills_project: &[],
            skills_user: &[],
            skills_read_by: NONE,
        },
    }
}

// ── helpers ──────────────────────────────────────────────────────────────

struct FrontMatter {
    values: HashMap<String, String>,
    body: String,
    has_front_matter: bool,
}

fn front_matter(content: &str) -> FrontMatter {
    let normalized = content.strip_prefix('\u{feff}').unwrap_or(content);
    let plain = || FrontMatter {
        values: HashMap::new(),
        body: normalized.trim().to_owned(),
        has_front_matter: false,
    };
    if !normalized.starts_with("---") {
        return plain();
    }
    let Some(end) = normalized[3..].find("\n---").map(|at| at + 3) else {
        return plain();
    };
    let values = normalized[3..end]
        .lines()
        .filter_map(front_matter_pair)
        .map(|(key, value)| (key.to_lowercase(), yaml_scalar(value)))
        .collect();
    let body = normalized
        .get(end + 4..)
        .and_then(|rest| rest.find('\n').map(|at| rest[at + 1..].trim().to_owned()))
        .unwrap_or_default();
    FrontMatter {
        values,
        body,
        has_front_matter: true,
    }
}

/// `csharp-dotnet-code-reviewer` becomes `Csharp Dotnet Code Reviewer`.
#[must_use]
pub fn humanize_identifier(value: &str) -> String {
    value
        .split(|c: char| c == '-' || c == '_' || c.is_whitespace())
        .filter(|word| !word.is_empty())
        .map(|word| {
            let mut chars = word.chars();
            chars
                .next()
                .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Claude agent descriptions often embed escaped newlines and `<example>` blocks meant for the
/// model's delegation logic; keep the human sentence.
#[must_use]
pub fn summarize_description(raw: Option<&str>) -> Option<String> {
    let raw = raw.filter(|raw| !raw.is_empty())?;
    let unescaped = raw.replace("\\n", "\n");
    let before_example = match unescaped.to_ascii_lowercase().find("<example>") {
        Some(at) => &unescaped[..at],
        None => &unescaped,
    };
    let first_paragraph = first_paragraph(before_example);
    let text = first_paragraph
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if text.is_empty() {
        return None;
    }
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= 240 {
        return Some(text);
    }
    let cut: String = chars[..240].iter().collect();
    Some(match cut.rfind(". ") {
        Some(sentence) if cut[..sentence].chars().count() > 80 => cut[..=sentence].to_owned(),
        _ => format!("{}…", cut.trim_end()),
    })
}

/// Text up to the first `\n\s*\n`.
fn first_paragraph(text: &str) -> &str {
    for (at, _) in text.match_indices('\n') {
        let rest = &text[at + 1..];
        let whitespace_run = rest.len() - rest.trim_start().len();
        if rest[..whitespace_run].contains('\n') {
            return &text[..at];
        }
    }
    text
}

fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn is_write_tool(tool: &str) -> bool {
    const WORDS: [&str; 11] = [
        "write",
        "edit",
        "multiedit",
        "bash",
        "shell",
        "notebookedit",
        "run_shell_command",
        "execute",
        "terminal",
        "create",
        "replace",
    ];
    let lower = tool.to_lowercase();
    WORDS.iter().any(|word| {
        lower.match_indices(word).any(|(at, _)| {
            let before = lower[..at].chars().next_back();
            let after = lower[at + word.len()..].chars().next();
            !before.is_some_and(is_word_char) && !after.is_some_and(is_word_char)
        })
    })
}

/// A tool list that grants nothing able to change files or run commands means read-only.
#[must_use]
pub fn tool_mode_from_list(tools: Option<&str>) -> Option<&'static str> {
    let tools = tools.map(str::trim).filter(|tools| !tools.is_empty())?;
    let tools = tools.strip_prefix('[').unwrap_or(tools);
    let tools = tools.strip_suffix(']').unwrap_or(tools);
    let list: Vec<String> = tools
        .split(|c: char| c == ',' || c.is_whitespace())
        .map(|item| item.replace(['\'', '"'], "").trim().to_owned())
        .filter(|item| !item.is_empty())
        .collect();
    if list.is_empty() || list.iter().any(|tool| tool == "*") {
        return None;
    }
    if list.iter().any(|tool| is_write_tool(tool)) {
        None
    } else {
        Some("read-only")
    }
}

fn valid_id(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Parses a Claude Code, Copilot (`.agent.md`) or Gemini agent file into a Praxis profile.
#[must_use]
pub fn parse_native_agent(
    content: &str,
    file_name: &str,
    suffix: &str,
) -> (Value, Option<&'static str>) {
    let parsed = front_matter(content);
    let fallback_id = file_name
        .strip_suffix(suffix)
        .map(str::to_owned)
        .unwrap_or_else(|| {
            Path::new(file_name)
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default()
        });
    let name = parsed.values.get("name").filter(|name| !name.is_empty());
    let id = match name {
        Some(name) if valid_id(name) => name.clone(),
        _ => fallback_id,
    }
    .to_lowercase();
    let display_name = match name {
        Some(name)
            if !name.chars().all(|c| {
                c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-')
            }) =>
        {
            name.clone()
        }
        _ => humanize_identifier(&id),
    };
    let mut profile = json!({ "id": id, "name": display_name, "instructions": parsed.body });
    if let Some(description) =
        summarize_description(parsed.values.get("description").map(String::as_str))
    {
        profile["description"] = json!(description);
    }
    if let Some(mode) = tool_mode_from_list(parsed.values.get("tools").map(String::as_str)) {
        profile["toolMode"] = json!(mode);
    }
    let error = parsed
        .body
        .is_empty()
        .then_some("The agent file has no instructions after its front matter.");
    (profile, error)
}

fn read_small(path: &Path) -> Option<String> {
    let info = fs::metadata(path).ok()?;
    if !info.is_file() || info.len() > MAX_FILE_BYTES {
        return None;
    }
    fs::read_to_string(path).ok()
}

fn files_with_suffix(dir: &Path, suffix: &str) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| {
            entry.file_type().is_ok_and(|kind| kind.is_file())
                && entry.file_name().to_string_lossy().ends_with(suffix)
        })
        .map(|entry| entry.path())
        .collect();
    found.sort();
    found
}

fn display_path_for(
    file: &Path,
    scope: &str,
    project_root: Option<&Path>,
    home_dir: &Path,
) -> String {
    let base = if scope == "project" {
        project_root
    } else {
        Some(home_dir)
    };
    let relative = base
        .and_then(|base| file.strip_prefix(base).ok())
        .unwrap_or(file)
        .to_string_lossy()
        .into_owned();
    if scope == "user" {
        format!("~/{relative}")
    } else {
        relative
    }
}

/// The nearest ancestor holding `.git` (the project root other tools also use), else `dir`.
#[must_use]
pub fn find_project_root(dir: &Path) -> PathBuf {
    let start = resolve(dir);
    let mut current = start.clone();
    loop {
        if current.join(".git").exists() {
            return current;
        }
        match current.parent() {
            Some(parent) => current = parent.to_path_buf(),
            None => return start,
        }
    }
}

fn source_json(ecosystem: &str, scope: &str, path: &Path, read_by: &[&str]) -> Value {
    json!({ "ecosystem": ecosystem, "scope": scope, "path": path.to_string_lossy(), "readBy": read_by })
}

// ── discovery ────────────────────────────────────────────────────────────

#[must_use]
pub fn discover_native_sources(options: &NativeSourceOptions) -> NativeSourceDiscovery {
    let mut found = NativeSourceDiscovery {
        project_root: options.project_root.clone(),
        ..Default::default()
    };
    let mut bases: Vec<(&'static str, &Path)> = Vec::new();
    if let Some(root) = &options.project_root {
        bases.push(("project", root));
    }
    bases.push(("user", &options.home_dir));
    let trusted_for = |scope: &str| scope == "user" || options.project_approved;
    let mut seen_paths: HashSet<PathBuf> = HashSet::new();

    for ecosystem in NATIVE_ECOSYSTEMS
        .iter()
        .filter(|e| options.enabled.get(**e) != Some(&false))
    {
        let layout = layout(ecosystem);
        for &(scope, root) in &bases {
            let patterns = if scope == "project" {
                &layout.project_instructions
            } else {
                &layout.user_instructions
            };
            for pattern in patterns {
                let files = match (pattern.file, pattern.dir) {
                    (Some(name), _) => vec![root.join(name)],
                    (None, Some(folder)) => files_with_suffix(&root.join(folder), pattern.suffix),
                    _ => Vec::new(),
                };
                for path in files {
                    if seen_paths.contains(&path) {
                        continue;
                    }
                    let Some(content) =
                        read_small(&path).filter(|content| !content.trim().is_empty())
                    else {
                        continue;
                    };
                    seen_paths.insert(path.clone());
                    let parsed = front_matter(&content);
                    let applies_to = parsed
                        .values
                        .get("applyto")
                        .or_else(|| parsed.values.get("globs"))
                        .filter(|v| !v.is_empty())
                        .cloned();
                    let always_applies = if path.to_string_lossy().ends_with(".mdc") {
                        parsed.values.get("alwaysapply").map(String::as_str) == Some("true")
                    } else {
                        applies_to
                            .as_deref()
                            .is_none_or(|glob| glob == "**" || glob == "**/*")
                    };
                    found.instructions.push(NativeInstructionFile {
                        ecosystem,
                        scope,
                        display_path: display_path_for(
                            &path,
                            scope,
                            options.project_root.as_deref(),
                            &options.home_dir,
                        ),
                        path,
                        read_by: pattern.read_by,
                        bytes: content.len(),
                        fingerprint: fingerprint(&content),
                        content: if parsed.has_front_matter {
                            parsed.body
                        } else {
                            content.trim().to_owned()
                        },
                        always_applies,
                        applies_to,
                    });
                }
            }

            let agent_dir = if scope == "project" {
                layout.agent_project
            } else {
                layout.agent_user
            };
            if let Some(agent_dir) = agent_dir {
                for path in files_with_suffix(&root.join(agent_dir), layout.agent_suffix) {
                    let Some(content) = read_small(&path) else {
                        continue;
                    };
                    let name = path
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    let (profile, error) = parse_native_agent(&content, &name, layout.agent_suffix);
                    let mut entry = json!({
                        "profile": profile,
                        "profilePath": path.to_string_lossy(),
                        "rootPath": path.parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
                        "fingerprint": fingerprint(&content),
                        "scope": if scope == "project" { "project" } else { "global" },
                        "trusted": trusted_for(scope),
                        "legacy": false,
                        "source": source_json(ecosystem, scope, &path, layout.agent_read_by)
                    });
                    if let Some(error) = error {
                        entry["error"] = json!(error);
                    }
                    found.agents.push(entry);
                }
            }

            let skill_dirs = if scope == "project" {
                layout.skills_project
            } else {
                layout.skills_user
            };
            for skill_dir in skill_dirs {
                let dir = root.join(skill_dir);
                let trusted_roots = if trusted_for(scope) {
                    vec![dir.clone()]
                } else {
                    Vec::new()
                };
                for mut skill in discover_skills(&[dir], &trusted_roots) {
                    let skill_path = PathBuf::from(skill["skillPath"].as_str().unwrap_or_default());
                    skill["scope"] = json!(if scope == "project" {
                        "project"
                    } else {
                        "global"
                    });
                    skill["trusted"] = json!(trusted_for(scope));
                    skill["source"] =
                        source_json(ecosystem, scope, &skill_path, layout.skills_read_by);
                    found.skills.push(skill);
                }
            }
        }
    }

    for extra in &options.extra_skill_paths {
        for mut skill in discover_skills(std::slice::from_ref(extra), std::slice::from_ref(extra)) {
            let skill_path = PathBuf::from(skill["skillPath"].as_str().unwrap_or_default());
            skill["scope"] = json!("global");
            skill["trusted"] = json!(true);
            skill["source"] = source_json("agents", "user", &skill_path, NONE);
            found.skills.push(skill);
        }
    }
    for extra in &options.extra_agent_paths {
        for path in files_with_suffix(extra, ".md") {
            let Some(content) = read_small(&path) else {
                continue;
            };
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let suffix = if name.ends_with(".agent.md") {
                ".agent.md"
            } else {
                ".md"
            };
            let (profile, error) = parse_native_agent(&content, &name, suffix);
            let mut entry = json!({
                "profile": profile,
                "profilePath": path.to_string_lossy(),
                "rootPath": extra.to_string_lossy(),
                "fingerprint": fingerprint(&content),
                "scope": "global",
                "trusted": true,
                "legacy": false,
                "source": source_json("agents", "user", &path, NONE)
            });
            if let Some(error) = error {
                entry["error"] = json!(error);
            }
            found.agents.push(entry);
        }
    }
    found
}

// ── one entry per id ─────────────────────────────────────────────────────

/// Lower wins. Praxis's own items (project, then global) beat other tools' files; among those a
/// project's beat the user's; the built-in item is the fallback.
fn catalog_rank(item: &Value) -> u8 {
    match item.get("source").filter(|source| !source.is_null()) {
        None if item["builtIn"] == true => 4,
        None => u8::from(item["scope"] != "project"),
        Some(source) => {
            if source["scope"] == "project" {
                2
            } else {
                3
            }
        }
    }
}

fn source_label(source: &Value) -> String {
    format!(
        "{} · {}",
        ecosystem_label(source["ecosystem"].as_str().unwrap_or_default()),
        if source["scope"] == "project" {
            "project"
        } else {
            "your user folder"
        }
    )
}

/// Keeps one item per id by `catalog_rank`, recording where else it was found (`alsoIn`).
#[must_use]
pub fn merge_by_id(items: Vec<Value>, id_of: impl Fn(&Value) -> String) -> Vec<Value> {
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Vec<Value>> = HashMap::new();
    for item in items {
        let id = id_of(&item);
        if !groups.contains_key(&id) {
            order.push(id.clone());
        }
        groups.entry(id).or_default().push(item);
    }
    order
        .into_iter()
        .filter_map(|id| {
            let mut group = groups.remove(&id)?;
            group.sort_by_key(catalog_rank); // stable
            let mut rest = group.split_off(1);
            let mut winner = group.pop()?;
            let mut also_in: Vec<String> = Vec::new();
            for item in rest.drain(..) {
                let label = match item.get("source").filter(|source| !source.is_null()) {
                    Some(source) => source_label(source),
                    None if item["builtIn"] == true => "Praxis built-in".to_owned(),
                    None => "Praxis".to_owned(),
                };
                if !also_in.contains(&label) {
                    also_in.push(label);
                }
            }
            if !also_in.is_empty() {
                winner["alsoIn"] = json!(also_in);
            }
            Some(winner)
        })
        .collect()
}

// ── instructions for a session ───────────────────────────────────────────

const INSTRUCTION_ORDER: [&str; 5] = [
    "AGENTS.md",
    "CLAUDE.md",
    ".claude/CLAUDE.md",
    "GEMINI.md",
    ".github/copilot-instructions.md",
];

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionInstructions {
    pub text: String,
    pub included: Vec<String>,
    /// `(displayPath, reason)`.
    pub skipped: Vec<(String, &'static str)>,
}

/// The project instruction files a session on `runtime` should receive from Praxis: every
/// always-applying project file that runtime does not already load itself, identical content
/// once, `AGENTS.md` first, bounded in size. `source` limits to one tool's files (`all` = any).
#[must_use]
pub fn build_session_instructions(
    files: &[NativeInstructionFile],
    runtime: &str,
    project_approved: bool,
    source: &str,
) -> SessionInstructions {
    let rank = |file: &NativeInstructionFile| {
        INSTRUCTION_ORDER
            .iter()
            .position(|name| *name == file.display_path)
            .unwrap_or(INSTRUCTION_ORDER.len())
    };
    let mut ordered: Vec<&NativeInstructionFile> = files.iter().collect();
    ordered.sort_by(|a, b| {
        rank(a)
            .cmp(&rank(b))
            .then_with(|| locale_cmp(&a.display_path, &b.display_path))
    });
    let mut result = SessionInstructions::default();
    let mut seen: HashSet<String> = HashSet::new();
    let mut sections: Vec<String> = Vec::new();
    let mut used = 0usize;
    for file in ordered {
        let mut skip =
            |reason: &'static str| result.skipped.push((file.display_path.clone(), reason));
        if file.scope != "project" {
            skip("user-scope");
            continue;
        }
        if !project_approved {
            skip("untrusted");
            continue;
        }
        if source != "all" && !source.is_empty() && file.ecosystem != source {
            skip("other-source");
            continue;
        }
        if file.read_by.contains(&runtime) {
            skip("native");
            continue;
        }
        if !file.always_applies {
            skip("path-specific");
            continue;
        }
        let normalized = file
            .content
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if normalized.is_empty() || seen.contains(&normalized) {
            skip("duplicate");
            continue;
        }
        let length = file.content.chars().count();
        if used + length > MAX_INSTRUCTION_CHARS {
            skip("size-limit");
            continue;
        }
        seen.insert(normalized);
        used += length;
        result.included.push(file.display_path.clone());
        sections.push(format!(
            "### {}\n\n{}",
            file.display_path,
            file.content.trim()
        ));
    }
    if !sections.is_empty() {
        let mut parts = vec![
            "## Project instructions".to_owned(),
            "This project keeps instructions for AI tools in the files below. Follow them as project conventions unless they conflict with the task or with Praxis instructions.".to_owned(),
        ];
        parts.extend(sections);
        result.text = parts.join("\n\n");
    }
    result
}

/// The snapshot's `nativeProject`, present only when something was found under a project root.
#[must_use]
pub fn native_project_json(found: &NativeSourceDiscovery, approved: bool) -> Option<Value> {
    let root = found.project_root.as_ref()?;
    let project_items = found
        .agents
        .iter()
        .chain(found.skills.iter())
        .filter(|item| item["source"]["scope"] == "project")
        .count()
        + found
            .instructions
            .iter()
            .filter(|file| file.scope == "project")
            .count();
    let total = found.agents.len() + found.skills.len() + found.instructions.len();
    (total > 0).then(|| json!({ "root": root.to_string_lossy(), "approved": approved, "itemCount": project_items }))
}

/// Host definitions for agents from other tools: they run on whatever runtime the session uses.
#[must_use]
pub fn session_hosts(profiles: &[Value], existing_host_ids: &HashSet<String>) -> Vec<Value> {
    let mut seen = existing_host_ids.clone();
    let mut hosts = Vec::new();
    for entry in profiles {
        let id = entry["profile"]["id"].as_str().unwrap_or_default();
        if entry.get("source").is_none_or(Value::is_null) || !seen.insert(id.to_owned()) {
            continue;
        }
        let mut host = Map::new();
        host.insert("manifest".into(), json!({ "schemaVersion": 1, "id": id, "name": entry["profile"]["name"], "type": "gateway", "entry": "session" }));
        host.insert("manifestPath".into(), entry["profilePath"].clone());
        host.insert("rootPath".into(), entry["rootPath"].clone());
        host.insert("scope".into(), entry["scope"].clone());
        host.insert("trusted".into(), entry["trusted"].clone());
        host.insert("errors".into(), json!([]));
        host.insert("followsSessionRuntime".into(), json!(true));
        hosts.push(Value::Object(host));
    }
    hosts
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put(root: &Path, file: &str, content: &str) {
        let path = root.join(file);
        fs::create_dir_all(path.parent().expect("parent")).expect("dirs");
        fs::write(path, content).expect("write");
    }

    fn fixture(tag: &str) -> (PathBuf, PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("praxis-native-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let (repo, home) = (base.join("repo"), base.join("home"));
        fs::create_dir_all(repo.join(".git")).expect("git");
        put(&repo, "AGENTS.md", "# Conventions\n\nPELICAN.");
        put(&repo, "CLAUDE.md", "CORMORANT.");
        put(
            &repo,
            ".claude/agents/release-notes.md",
            "---\nname: release-notes\ndescription: Drafts release notes.\ntools: Read, Grep\n---\nSign off with HERON.",
        );
        put(
            &repo,
            ".claude/skills/deploy/SKILL.md",
            "---\nname: deploy\ndescription: Deploys.\n---\nKESTREL.",
        );
        put(
            &home,
            ".claude/agents/csharp-reviewer.md",
            "---\nname: csharp-reviewer\ndescription: Reviews C#.\n---\nYou review C#.",
        );
        put(&home, ".codex/AGENTS.md", "Personal.");
        (base, repo, home)
    }

    fn options(repo: &Path, home: &Path, approved: bool) -> NativeSourceOptions {
        NativeSourceOptions {
            project_root: Some(repo.to_path_buf()),
            home_dir: home.to_path_buf(),
            project_approved: approved,
            ..Default::default()
        }
    }

    #[test]
    fn discovers_agents_skills_and_instructions_with_trust() {
        let (base, repo, home) = fixture("disc");
        let found = discover_native_sources(&options(&repo, &home, false));
        let project_agent = found
            .agents
            .iter()
            .find(|a| a["profile"]["id"] == "release-notes")
            .expect("agent");
        assert_eq!(project_agent["trusted"], false);
        assert_eq!(project_agent["profile"]["name"], "Release Notes");
        assert_eq!(project_agent["profile"]["toolMode"], "read-only");
        assert_eq!(
            project_agent["source"]["readBy"],
            json!(["claude-code-cli"])
        );
        let user_agent = found
            .agents
            .iter()
            .find(|a| a["profile"]["id"] == "csharp-reviewer")
            .expect("user agent");
        assert_eq!(user_agent["trusted"], true);
        assert_eq!(user_agent["scope"], "global");
        assert!(
            found
                .skills
                .iter()
                .any(|s| s["metadata"]["name"] == "deploy" && s["trusted"] == false)
        );
        let paths: Vec<&str> = found
            .instructions
            .iter()
            .map(|f| f.display_path.as_str())
            .collect();
        assert!(
            paths.contains(&"AGENTS.md")
                && paths.contains(&"CLAUDE.md")
                && paths.contains(&"~/.codex/AGENTS.md"),
            "{paths:?}"
        );
        let approved = discover_native_sources(&options(&repo, &home, true));
        assert!(approved.agents.iter().all(|a| a["trusted"] == true));
        let summary = native_project_json(&approved, true).expect("project");
        assert_eq!(summary["itemCount"], 2 + 2);
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn session_instructions_skip_native_user_and_untrusted_files() {
        let (base, repo, home) = fixture("instr");
        let found = discover_native_sources(&options(&repo, &home, true));
        let api = build_session_instructions(&found.instructions, "gateway", true, "all");
        assert!(api.text.contains("PELICAN") && api.text.contains("CORMORANT"));
        assert!(!api.text.contains("Personal"));
        assert!(
            api.text.find("PELICAN") < api.text.find("CORMORANT"),
            "AGENTS.md first"
        );
        let claude =
            build_session_instructions(&found.instructions, "claude-code-cli", true, "all");
        assert!(!claude.text.contains("CORMORANT") && claude.text.contains("PELICAN"));
        let only_claude =
            build_session_instructions(&found.instructions, "gateway", true, "claude");
        assert!(only_claude.text.contains("CORMORANT") && !only_claude.text.contains("PELICAN"));
        assert!(
            build_session_instructions(&found.instructions, "gateway", false, "all")
                .text
                .is_empty()
        );
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn a_disabled_ecosystem_is_not_read() {
        let (base, repo, home) = fixture("off");
        let mut opts = options(&repo, &home, true);
        opts.enabled.insert("claude".into(), false);
        let found = discover_native_sources(&opts);
        assert!(found.agents.is_empty() && found.skills.is_empty());
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn merge_prefers_praxis_then_project_and_records_also_in() {
        let own = json!({ "profile": { "id": "a" }, "scope": "global" });
        let project = json!({ "profile": { "id": "a" }, "scope": "project", "source": { "ecosystem": "claude", "scope": "project" } });
        let user = json!({ "profile": { "id": "a" }, "scope": "global", "source": { "ecosystem": "codex", "scope": "user" } });
        let merged = merge_by_id(vec![user.clone(), project.clone()], |v| {
            v["profile"]["id"].as_str().unwrap().to_owned()
        });
        assert_eq!(merged[0]["source"]["ecosystem"], "claude");
        assert_eq!(merged[0]["alsoIn"], json!(["Codex · your user folder"]));
        let merged = merge_by_id(vec![project, own, user], |v| {
            v["profile"]["id"].as_str().unwrap().to_owned()
        });
        assert!(merged[0].get("source").is_none());
        assert_eq!(
            merged[0]["alsoIn"],
            json!(["Claude Code · project", "Codex · your user folder"])
        );
    }

    #[test]
    fn descriptions_and_tool_modes_match_the_typescript() {
        assert_eq!(
            summarize_description(Some("Does it.\\n\\n<example>x</example>")).as_deref(),
            Some("Does it.")
        );
        assert_eq!(tool_mode_from_list(Some("Read, Grep")), Some("read-only"));
        assert_eq!(tool_mode_from_list(Some("[Read, Bash]")), None);
        assert_eq!(tool_mode_from_list(Some("*")), None);
        assert_eq!(humanize_identifier("csharp-dotnet_x"), "Csharp Dotnet X");
        let (profile, error) = parse_native_agent("---\nname: Fancy Name\n---\n", "x.md", ".md");
        assert_eq!(profile["id"], "x");
        assert_eq!(profile["name"], "Fancy Name");
        assert!(error.is_some());
    }
}
