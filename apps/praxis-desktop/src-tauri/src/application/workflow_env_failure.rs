//! Telling "the check found a problem" from "the check could not run" (`checkEnvironmentFailure.ts`).
//!
//! Deliberately narrow: a false "environment" verdict hides a real failure behind a pause, which is
//! worse than a false failure. It only fires on a command that does not exist, a stage the project
//! was never set up for (a missing npm script, `tsc` with no tsconfig), or a package manager doing
//! registry work whose output carries a specific registry or network signature.

use regex::Regex;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckEnvironmentFailure {
    pub reason: String,
    pub hint: String,
}

pub struct CheckEnvironmentInput<'a> {
    pub command: &'a str,
    pub args: &'a [String],
    pub exit_code: Option<i32>,
    pub output: &'a str,
    pub spawn_error: &'a str,
}

const PACKAGE_MANAGERS: [&str; 5] = ["npm", "npx", "pnpm", "yarn", "bun"];
const REGISTRY_SUBCOMMANDS: [&str; 15] = [
    "audit", "install", "i", "ci", "add", "update", "up", "upgrade", "outdated", "view", "info",
    "ping", "whoami", "publish", "dedupe",
];

fn base_name(command: &str) -> String {
    let name = command
        .trim()
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(command)
        .to_lowercase();
    for suffix in [".cmd", ".exe", ".bat", ".ps1"] {
        if let Some(stripped) = name.strip_suffix(suffix) {
            return stripped.to_string();
        }
    }
    name
}

fn subcommand(args: &[String]) -> Option<String> {
    args.iter()
        .find(|a| !a.starts_with('-'))
        .map(|a| a.to_lowercase())
}

fn script_name(command: &str, args: &[String]) -> Option<String> {
    let positional: Vec<&String> = args.iter().filter(|a| !a.starts_with('-')).collect();
    let first = positional.first()?;
    if *first == "run" || *first == "run-script" {
        return positional.get(1).map(|s| (*s).clone());
    }
    if *first == "test" || *first == "t" {
        return Some("test".to_string());
    }
    (command == "pnpm" || command == "yarn").then(|| (*first).clone())
}

fn missing_script(command: &str, args: &[String], output: &str) -> Option<String> {
    let script = script_name(command, args)?;
    let name = regex::escape(&script);
    let signatures = [
        format!(r#"(?i)Missing script: "?{name}"?(?:\s|$)"#),
        format!(r#"(?i)Command "{name}" not found"#),
    ];
    signatures
        .iter()
        .any(|pattern| Regex::new(pattern).is_ok_and(|re| re.is_match(output)))
        .then_some(script)
}

fn failed_host(output: &str) -> Option<String> {
    Regex::new(r"(?i)\b(?:GET|POST|PUT|HEAD)\s+https?://([^/\s]+)")
        .ok()?
        .captures(output)
        .map(|c| c[1].to_string())
}

fn matches(pattern: &str, text: &str) -> bool {
    Regex::new(pattern).is_ok_and(|re| re.is_match(text))
}

#[must_use]
pub fn classify_check_environment_failure(
    input: &CheckEnvironmentInput<'_>,
) -> Option<CheckEnvironmentFailure> {
    let command = base_name(input.command);
    if matches(r"(?i)ENOENT|not found|not recognized", input.spawn_error) || input.exit_code == Some(127) {
        return Some(CheckEnvironmentFailure {
            reason: format!("\"{}\" was not found on this machine.", input.command),
            hint: format!("Install {} (or fix the stage's command), then retry.", input.command),
        });
    }
    let failed = input.exit_code != Some(0);
    if failed && PACKAGE_MANAGERS.contains(&command.as_str()) {
        if let Some(script) = missing_script(&command, input.args, input.output) {
            return Some(CheckEnvironmentFailure {
                reason: format!("This project has no \"{script}\" script, so the stage did not run."),
                hint: format!("Add a \"{script}\" script to package.json, or change the stage's command to one this project has, then retry."),
            });
        }
    }
    let is_tsc = command == "tsc" || (command == "npx" && subcommand(input.args).as_deref() == Some("tsc"));
    if failed
        && is_tsc
        && input.output.contains("tsc: The TypeScript Compiler - Version")
        && input.output.contains("COMMON COMMANDS")
    {
        return Some(CheckEnvironmentFailure {
            reason: "tsc found no tsconfig.json in the folder the stage runs in, so it printed its help instead of type-checking.".into(),
            hint: "Add a tsconfig.json there, or change the stage's command (for a monorepo, the script that type-checks every package), then retry.".into(),
        });
    }
    if !PACKAGE_MANAGERS.contains(&command.as_str()) {
        return None;
    }
    let sub = subcommand(input.args)?;
    if !REGISTRY_SUBCOMMANDS.contains(&sub.as_str()) {
        return None;
    }
    let out = input.output;
    if sub == "audit"
        && matches(
            r"(?i)audit endpoint returned an error|advisories/bulk|npm warn audit (?:40\d|50\d)|audit.{0,20}\b(?:404|501)\b",
            out,
        )
    {
        let host = failed_host(out);
        return Some(CheckEnvironmentFailure {
            reason: format!(
                "{} does not support security audits.",
                host.map_or_else(|| "The configured package registry".to_string(), |h| format!("The package registry {h}"))
            ),
            hint: "Point this stage at the public registry, for example by adding --registry=https://registry.npmjs.org/ to its arguments, then retry.".into(),
        });
    }
    if matches(r"(?i)\b(?:E401|E403|ENEEDAUTH)\b|unable to authenticate|401 Unauthorized", out) {
        let host = failed_host(out);
        return Some(CheckEnvironmentFailure {
            reason: format!(
                "{} rejected the credentials.",
                host.map_or_else(|| "The package registry".to_string(), |h| format!("The package registry {h}"))
            ),
            hint: "Check the auth token in your .npmrc, then retry.".into(),
        });
    }
    if matches(
        r"(?i)self[- ]signed certificate|UNABLE_TO_GET_ISSUER_CERT|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        out,
    ) {
        return Some(CheckEnvironmentFailure {
            reason: "The package registry's TLS certificate could not be verified.".into(),
            hint: "Fix the certificate or proxy configuration, then retry.".into(),
        });
    }
    if matches(
        r"(?i)\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH)\b|network (?:request|connectivity|error)|request to https?://\S+ failed",
        out,
    ) {
        return Some(CheckEnvironmentFailure {
            reason: "The package registry could not be reached.".into(),
            hint: "Check the network or proxy, then retry.".into(),
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input<'a>(command: &'a str, args: &'a [String], code: Option<i32>, output: &'a str) -> CheckEnvironmentInput<'a> {
        CheckEnvironmentInput { command, args, exit_code: code, output, spawn_error: "" }
    }

    #[test]
    fn a_missing_command_is_an_environment_problem() {
        let found = classify_check_environment_failure(&input("semgrep", &[], Some(127), ""));
        assert!(found.unwrap().reason.contains("was not found"));
    }

    #[test]
    fn a_real_test_failure_is_never_second_guessed() {
        let args = vec!["test".to_string()];
        assert!(classify_check_environment_failure(&input("npm", &args, Some(1), "1 failing")).is_none());
    }

    #[test]
    fn an_npm_audit_against_a_registry_without_an_audit_endpoint_pauses() {
        let args = vec!["audit".to_string()];
        let out = "npm error audit endpoint returned an error\nGET https://registry.example/-/npm/v1/security/advisories/bulk";
        let found = classify_check_environment_failure(&input("npm", &args, Some(1), out)).unwrap();
        assert!(found.reason.contains("registry.example"));
    }

    #[test]
    fn a_missing_script_is_not_configured() {
        let args = vec!["run".to_string(), "lint".to_string()];
        let found = classify_check_environment_failure(&input("npm", &args, Some(1), "npm error Missing script: \"lint\"\n")).unwrap();
        assert!(found.reason.contains("no \"lint\" script"));
    }
}
