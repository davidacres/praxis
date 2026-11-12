//! Account quota for the Codex and Claude Code CLIs: the Rust port of Electron's `codexUsage.ts`,
//! `claudeUsage.ts` and `claudeUsageText.ts`.
//!
//! Praxis never handles either login token. Codex is asked through its own `app-server` JSON-RPC
//! (`account/rateLimits/read`, a read-only call); Claude Code is asked to print `/usage`, a local
//! command that makes no model call. Every failure is a reason on the snapshot, never a zero.
//!
//! `PRAXIS_CODEX_CLI` / `PRAXIS_CLAUDE_CLI` replace the executables (the e2e suite points them at
//! fixtures; a person can use them for a CLI outside `PATH`).

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use chrono::{DateTime, Datelike, Duration as ChronoDuration, Local, TimeZone, Utc};
use chrono_tz::Tz;
use praxis_ai::providers::environment::effective_path;
use praxis_ai::providers::provider_limit_error::{
    extract_provider_limit_message, is_provider_limit_error,
};
use praxis_ai::providers::registry::resolve_executable;
use regex::Regex;
use serde_json::{Value, json};

use super::now;

pub const CODEX: &str = "codex-cli";
pub const CLAUDE: &str = "claude-code-cli";

const CODEX_TIMEOUT: Duration = Duration::from_secs(7);
const CLAUDE_TIMEOUT: Duration = Duration::from_secs(20);
/// The windows move slowly and each read spawns the CLI, so reuse one for a few minutes.
const WINDOWS_TTL: Duration = Duration::from_secs(3 * 60);
/// A failed read retries sooner than a good one.
const FAILED_RETRY: Duration = Duration::from_secs(30);

// ── Claude `/usage` text ─────────────────────────────────────────────────────────────────────

fn line_pattern() -> &'static Regex {
    static PATTERN: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r"(?i)^\s*Current (session|week)(?:\s*\(([^)]*)\))?\s*:\s*(\d+(?:\.\d+)?)%\s*used(?:\s*[·•-]\s*resets?\s+(.+?))?\s*$",
        )
        .expect("static pattern")
    });
    &PATTERN
}

fn reset_pattern() -> &'static Regex {
    static PATTERN: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r"(?i)^(?:(?P<month>[A-Za-z]{3,9})\s+(?P<day>\d{1,2})\s*(?:,?\s*at\s+)?)?(?P<hour>\d{1,2})(?::(?P<minute>\d{2}))?\s*(?P<meridiem>am|pm)\s*(?:\((?P<zone>[^)]+)\))?\s*$",
        )
        .expect("static pattern")
    });
    &PATTERN
}

const MONTHS: [&str; 12] = [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];

/// The instant at which `zone`'s wall clock reads the given date and time. A wall time skipped by
/// a daylight-saving jump has no instant, and an ambiguous one takes the earlier.
fn wall_clock<Z: TimeZone>(
    zone: &Z,
    year: i32,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
) -> Option<DateTime<Utc>> {
    zone.with_ymd_and_hms(year, month, day, hour, minute, 0)
        .earliest()
        .map(|instant| instant.with_timezone(&Utc))
}

fn resolve_reset<Z: TimeZone>(
    zone: &Z,
    now: DateTime<Utc>,
    month: Option<u32>,
    day: u32,
    hour: u32,
    minute: u32,
) -> Option<DateTime<Utc>> {
    let today = now.with_timezone(zone);
    if let Some(month) = month {
        let mut instant = wall_clock(zone, today.year(), month, day, hour, minute)?;
        // A date well before now is next year's occurrence (a late-December read of "Jan 2").
        if instant < now - ChronoDuration::hours(24) {
            instant = wall_clock(zone, today.year() + 1, month, day, hour, minute)?;
        }
        Some(instant)
    } else {
        let mut instant = wall_clock(zone, today.year(), today.month(), today.day(), hour, minute)?;
        if instant < now {
            instant += ChronoDuration::hours(24);
        }
        Some(instant)
    }
}

/// A reset such as "Oct 7 at 4am (Europe/London)" as an ISO instant, or `None` if it does not
/// parse (including an unknown time zone: the window is still useful without a reset).
pub fn parse_claude_reset(text: &str, now: DateTime<Utc>) -> Option<String> {
    let captures = reset_pattern().captures(text.trim())?;
    let hour: u32 = captures["hour"].parse().ok()?;
    let minute: u32 = captures
        .name("minute")
        .map_or(Some(0), |m| m.as_str().parse().ok())?;
    let mut hours = hour % 12;
    if captures["meridiem"].eq_ignore_ascii_case("pm") {
        hours += 12;
    }
    let month = match captures.name("month") {
        Some(name) => {
            let prefix = name.as_str().get(..3)?.to_ascii_lowercase();
            Some(MONTHS.iter().position(|m| *m == prefix)? as u32 + 1)
        }
        None => None,
    };
    let day: u32 = captures
        .name("day")
        .map_or(Some(1), |d| d.as_str().parse().ok())?;
    let instant = match captures.name("zone") {
        Some(zone) => {
            let zone: Tz = zone.as_str().trim().parse().ok()?;
            resolve_reset(&zone, now, month, day, hours, minute)?
        }
        None => resolve_reset(&Local, now, month, day, hours, minute)?,
    };
    Some(instant.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

/// Windows named in a `/usage` reply. Empty when the text is not a plan-usage report (API-key
/// logins have none).
pub fn parse_claude_usage_text(text: &str, now: DateTime<Utc>) -> Vec<Value> {
    text.lines()
        .filter_map(|line| {
            let captures = line_pattern().captures(line)?;
            let is_session = captures[1].eq_ignore_ascii_case("session");
            let scope = captures.get(2).map(|s| s.as_str().trim());
            let all_models =
                scope.is_none_or(|s| s.is_empty() || s.eq_ignore_ascii_case("all models"));
            let label = if is_session {
                "5-hour window".to_owned()
            } else if all_models {
                "Weekly window".to_owned()
            } else {
                let scope = scope.unwrap_or_default();
                let trimmed = Regex::new(r"(?i)\s+only$")
                    .expect("static pattern")
                    .replace(scope, "")
                    .into_owned();
                format!("Weekly · {trimmed}")
            };
            let percent: f64 = captures[3].parse().ok()?;
            let mut window = json!({
                "period": if is_session { "hour" } else { "week" },
                "label": label,
                "usedPercent": percent.round().min(100.0),
                "windowDurationMinutes": if is_session { 300 } else { 7 * 24 * 60 },
            });
            if let Some(reset) = captures
                .get(4)
                .and_then(|r| parse_claude_reset(r.as_str(), now))
            {
                window["resetsAt"] = json!(reset);
            }
            Some(window)
        })
        .collect()
}

// ── running the CLIs ─────────────────────────────────────────────────────────────────────────

fn executable(env_override: &str, default: &str) -> Option<std::path::PathBuf> {
    let command = std::env::var(env_override)
        .ok()
        .map(|c| c.trim().to_owned())
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| default.to_owned());
    resolve_executable(&command, effective_path())
}

fn unavailable(provider: &str, reason: impl Into<String>, code: &str) -> Value {
    json!({
        "provider": provider,
        "fetchedAt": now(),
        "windows": [],
        "unavailableReason": reason.into(),
        "unavailableReasonCode": code
    })
}

/// Runs a command to completion, killing it at the deadline. Output past 1 MiB is dropped.
fn run_to_completion(
    program: &Path,
    args: &[&str],
    cwd: &Path,
    timeout: Duration,
) -> Result<String, String> {
    let mut child = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .env("PATH", effective_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = std::io::Read::read_to_string(
            &mut std::io::Read::take(&mut stdout, 1 << 20),
            &mut text,
        );
        text
    });
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let text = reader.join().unwrap_or_default();
                return if status.success() {
                    Ok(text)
                } else {
                    Err(format!("exited with {status}"))
                };
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("timed out".into());
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

// ── Codex ────────────────────────────────────────────────────────────────────────────────────

/// Asks `codex app-server --stdio` for the account's rate limits and lifetime tokens.
/// `(rate limits result, usage result)`; the usage read is best effort.
fn codex_rpc(program: &Path) -> Result<(Value, Option<Value>), String> {
    let mut child = Command::new(program)
        .args(["app-server", "--stdio"])
        .env("PATH", effective_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Codex CLI is unavailable: {e}"))?;
    let outcome = (|| {
        let mut stdin = child.stdin.take().ok_or("Codex app-server has no input.")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Codex app-server has no output.")?;
        let (lines_tx, lines) = mpsc::channel::<Value>();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(message) = serde_json::from_str::<Value>(line.trim())
                    && lines_tx.send(message).is_err()
                {
                    break;
                }
            }
        });
        let mut send = |id: u64, method: &str, params: Value| -> Result<(), String> {
            let request = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
            writeln!(stdin, "{request}")
                .and_then(|()| stdin.flush())
                .map_err(|e| format!("Codex app-server closed its input: {e}"))
        };
        let deadline = Instant::now() + CODEX_TIMEOUT;
        let wait_for = |id: u64| -> Result<Value, String> {
            loop {
                let left = deadline.saturating_duration_since(Instant::now());
                match lines.recv_timeout(left) {
                    Ok(message) if message["id"] == id => {
                        return match message.get("error").filter(|e| !e.is_null()) {
                            Some(error) => Err(error["message"]
                                .as_str()
                                .unwrap_or("Codex app-server request failed.")
                                .to_owned()),
                            None => Ok(message["result"].clone()),
                        };
                    }
                    Ok(_) => {}
                    Err(RecvTimeoutError::Timeout) => {
                        return Err("Codex app-server request timed out.".into());
                    }
                    Err(RecvTimeoutError::Disconnected) => {
                        return Err("Codex app-server exited before answering.".into());
                    }
                }
            }
        };
        send(
            1,
            "initialize",
            json!({ "clientInfo": { "name": "praxis", "version": "1.0.0" }, "capabilities": null }),
        )?;
        wait_for(1)?;
        send(2, "account/rateLimits/read", Value::Null)?;
        send(3, "account/usage/read", json!({}))?;
        let limits = wait_for(2)?;
        let usage = wait_for(3).ok();
        Ok::<_, String>((limits, usage))
    })();
    let _ = child.kill();
    let _ = child.wait();
    outcome
}

fn codex_window(period: &str, label: &str, window: &Value) -> Option<Value> {
    if !window.is_object() {
        return None;
    }
    let mut out = json!({ "period": period, "label": label });
    if let Some(percent) = window["usedPercent"].as_f64() {
        out["usedPercent"] = json!(percent);
    }
    if let Some(minutes) = window["windowDurationMins"].as_u64() {
        out["windowDurationMinutes"] = json!(minutes);
    }
    if let Some(reset) = window["resetsAt"]
        .as_i64()
        .and_then(|secs| DateTime::from_timestamp(secs, 0))
    {
        out["resetsAt"] = json!(reset.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string());
    }
    Some(out)
}

pub fn codex_snapshot_from(response: &Value, usage: Option<&Value>) -> Value {
    let limits = &response["rateLimits"];
    if !limits.is_object() {
        return unavailable(
            CODEX,
            "Codex did not return account limits.",
            "fetch-failed",
        );
    }
    let windows: Vec<Value> = [
        codex_window("hour", "5-hour window", &limits["primary"]),
        codex_window("week", "Weekly window", &limits["secondary"]),
    ]
    .into_iter()
    .flatten()
    .collect();
    let mut snapshot = json!({ "provider": CODEX, "fetchedAt": now(), "windows": windows });
    if let Some(tokens) = usage.and_then(|u| u["summary"]["lifetimeTokens"].as_u64()) {
        snapshot["totalTokens"] = json!(tokens);
    }
    if let Some(count) = response["rateLimitResetCredits"]["availableCount"].as_f64() {
        snapshot["credits"] = json!({ "remaining": count, "currency": "reset credits" });
    }
    snapshot
}

fn codex_exchange() -> Result<(Value, Option<Value>), String> {
    let program = executable("PRAXIS_CODEX_CLI", "codex")
        .ok_or_else(|| "Codex CLI is unavailable: spawn codex ENOENT".to_owned())?;
    codex_rpc(&program)
}

pub fn codex_snapshot() -> Value {
    match codex_exchange() {
        Ok((response, usage)) => codex_snapshot_from(&response, usage.as_ref()),
        Err(reason) => unavailable(CODEX, reason, "cli-unavailable"),
    }
}

/// Lifetime tokens Codex reports for the account, if the installed CLI can say.
pub fn codex_lifetime_tokens() -> Option<u64> {
    let (_, usage) = codex_exchange().ok()?;
    usage?["summary"]["lifetimeTokens"].as_u64()
}

// ── Claude Code ──────────────────────────────────────────────────────────────────────────────

type WindowsCache = Option<(Instant, Duration, Vec<Value>, Option<String>)>;

fn windows_cache() -> &'static Mutex<WindowsCache> {
    static CACHE: LazyLock<Mutex<WindowsCache>> = LazyLock::new(Mutex::default);
    &CACHE
}

/// The 5-hour and weekly plan windows, read by asking Claude Code itself. Empty when the CLI is
/// missing, the login is an API key (no plan windows) or the reply does not parse.
fn read_plan_windows() -> Vec<Value> {
    let program_key = std::env::var("PRAXIS_CLAUDE_CLI").unwrap_or_default();
    {
        let cache = windows_cache()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some((at, ttl, windows, key)) = cache.as_ref()
            && at.elapsed() < *ttl
            && key.as_deref() == Some(program_key.as_str())
        {
            return windows.clone();
        }
    }
    let windows = executable("PRAXIS_CLAUDE_CLI", "claude")
        .and_then(|program| {
            run_to_completion(
                &program,
                &["-p", "/usage", "--no-session-persistence"],
                &std::env::temp_dir(),
                CLAUDE_TIMEOUT,
            )
            .ok()
        })
        .map(|text| parse_claude_usage_text(&text, Utc::now()))
        .unwrap_or_default();
    let ttl = if windows.is_empty() {
        FAILED_RETRY
    } else {
        WINDOWS_TTL
    };
    *windows_cache()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) =
        Some((Instant::now(), ttl, windows.clone(), Some(program_key)));
    windows
}

/// Input plus output tokens from Claude Code's own local stats cache; never the login.
pub fn claude_local_tokens(home: &Path) -> Option<u64> {
    let raw = std::fs::read_to_string(home.join(".claude").join("stats-cache.json")).ok()?;
    let stats: Value = serde_json::from_str(&raw).ok()?;
    let usage = stats["modelUsage"].as_object()?;
    let mut total = 0u64;
    for model in usage.values() {
        let part = |key: &str| match &model[key] {
            Value::Null => Some(0),
            value => value.as_u64(),
        };
        total += part("inputTokens")? + part("outputTokens")?;
    }
    (total > 0).then_some(total)
}

pub fn native_home() -> std::path::PathBuf {
    std::env::var("PRAXIS_NATIVE_SOURCES_HOME")
        .ok()
        .filter(|home| !home.trim().is_empty())
        .or_else(|| std::env::var("HOME").ok())
        .or_else(|| std::env::var("USERPROFILE").ok())
        .map(std::path::PathBuf::from)
        .unwrap_or_default()
}

/// `last_errors` are the recorded errors of Claude Code sessions that hit a provider limit; used
/// only when `/usage` yields nothing.
pub fn claude_snapshot(home: &Path, last_errors: &[String]) -> Value {
    claude_snapshot_from(read_plan_windows(), claude_local_tokens(home), last_errors)
}

pub fn claude_snapshot_from(
    plan_windows: Vec<Value>,
    tokens: Option<u64>,
    last_errors: &[String],
) -> Value {
    let mut snapshot = json!({ "provider": CLAUDE, "fetchedAt": now(), "windows": [] });
    if let Some(tokens) = tokens {
        snapshot["totalTokens"] = json!(tokens);
    }
    if !plan_windows.is_empty() {
        snapshot["windows"] = json!(plan_windows);
    } else if let Some(error) = last_errors.first() {
        // A session limit is a result, not an unavailability: real usage data, so the notice
        // rides the window label rather than `unavailableReason`.
        let notice = extract_provider_limit_message(error).unwrap_or_default();
        let label = Regex::new(r"(?i)resets\s+([^.\n]+)")
            .expect("static pattern")
            .captures(&notice)
            .map_or_else(
                || "Session limit reached".to_owned(),
                |c| format!("Resets {}", c[1].trim()),
            );
        snapshot["windows"] = json!([{ "period": "hour", "usedPercent": 100, "label": label }]);
    }
    snapshot
}

/// Recorded errors of Claude Code sessions that reported a provider limit.
pub fn claude_limit_errors(records: impl IntoIterator<Item = Value>) -> Vec<String> {
    records
        .into_iter()
        .filter(|r| r["provider"] == CLAUDE)
        .filter(|r| {
            r["providerLimitReached"] == true
                || r["lastError"].as_str().is_some_and(is_provider_limit_error)
        })
        .filter_map(|r| r["lastError"].as_str().map(str::to_owned))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("praxis-cli-usage-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        dir
    }

    fn at(text: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(text)
            .expect("time")
            .with_timezone(&Utc)
    }

    /// 01:30 in London (BST).
    fn now_fixture() -> DateTime<Utc> {
        at("2026-10-07T00:30:00Z")
    }

    #[test]
    fn reads_the_session_and_weekly_windows_from_a_real_usage_reply() {
        let text = [
            "You are currently using your subscription to power your Claude Code usage",
            "",
            "Current session: 23% used · resets Oct 7 at 4am (Europe/London)",
            "Current week (all models): 35% used · resets Oct 7 at 9am (Europe/London)",
            "",
            "Last 24h · 121 requests · 5 sessions",
        ]
        .join("\n");
        assert_eq!(
            parse_claude_usage_text(&text, now_fixture()),
            vec![
                json!({ "period": "hour", "label": "5-hour window", "usedPercent": 23.0, "windowDurationMinutes": 300, "resetsAt": "2026-10-07T03:00:00.000Z" }),
                json!({ "period": "week", "label": "Weekly window", "usedPercent": 35.0, "windowDurationMinutes": 10080, "resetsAt": "2026-10-07T08:00:00.000Z" }),
            ]
        );
    }

    #[test]
    fn a_model_scoped_weekly_window_keeps_its_own_label() {
        let windows = parse_claude_usage_text(
            "Current week (Opus only): 80% used · resets Oct 9 at 10:30pm (Europe/London)",
            now_fixture(),
        );
        assert_eq!(windows[0]["label"], "Weekly · Opus");
        assert_eq!(windows[0]["usedPercent"], 80.0);
        assert_eq!(windows[0]["resetsAt"], "2026-10-09T21:30:00.000Z");
    }

    #[test]
    fn a_window_without_a_reset_still_reports_its_percentage() {
        let windows = parse_claude_usage_text("Current session: 5% used", now_fixture());
        assert_eq!(windows[0]["usedPercent"], 5.0);
        assert!(windows[0].get("resetsAt").is_none());
    }

    #[test]
    fn a_reply_that_is_not_a_plan_report_yields_no_windows() {
        assert!(
            parse_claude_usage_text(
                "You are using an API key. /usage is unavailable.",
                now_fixture()
            )
            .is_empty()
        );
        assert!(parse_claude_usage_text("", now_fixture()).is_empty());
    }

    #[test]
    fn a_time_with_no_date_resolves_to_the_next_occurrence() {
        assert_eq!(
            parse_claude_reset("4am (Europe/London)", now_fixture()).as_deref(),
            Some("2026-10-07T03:00:00.000Z")
        );
        assert_eq!(
            parse_claude_reset("1am (Europe/London)", now_fixture()).as_deref(),
            Some("2026-10-08T00:00:00.000Z")
        );
    }

    #[test]
    fn a_past_month_rolls_into_next_year_and_winter_time_uses_the_winter_offset() {
        assert_eq!(
            parse_claude_reset("Jan 2 at 9am (Europe/London)", at("2026-12-30T12:00:00Z"))
                .as_deref(),
            Some("2027-01-02T09:00:00.000Z")
        );
    }

    #[test]
    fn an_unknown_time_zone_does_not_panic() {
        assert_eq!(
            parse_claude_reset("Oct 7 at 4am (Not/AZone)", now_fixture()),
            None
        );
    }

    #[test]
    fn codex_limits_map_to_hour_and_week_windows() {
        let response = json!({
            "rateLimits": {
                "primary": { "usedPercent": 41, "windowDurationMins": 300, "resetsAt": 1_791_000_000 },
                "secondary": { "usedPercent": 12.5, "windowDurationMins": 10080, "resetsAt": null }
            },
            "rateLimitResetCredits": { "availableCount": 2 }
        });
        let snapshot = codex_snapshot_from(
            &response,
            Some(&json!({ "summary": { "lifetimeTokens": 9000 } })),
        );
        assert_eq!(snapshot["windows"][0]["label"], "5-hour window");
        assert_eq!(snapshot["windows"][0]["usedPercent"], 41.0);
        assert_eq!(snapshot["windows"][0]["windowDurationMinutes"], 300);
        assert_eq!(
            snapshot["windows"][0]["resetsAt"],
            "2026-10-03T04:00:00.000Z"
        );
        assert_eq!(snapshot["windows"][1]["label"], "Weekly window");
        assert!(snapshot["windows"][1].get("resetsAt").is_none());
        assert_eq!(snapshot["totalTokens"], 9000);
        assert_eq!(snapshot["credits"]["currency"], "reset credits");
        assert!(snapshot.get("unavailableReason").is_none());
    }

    #[test]
    fn codex_without_limits_is_a_fetch_failure() {
        let snapshot = codex_snapshot_from(&json!({}), None);
        assert_eq!(snapshot["unavailableReasonCode"], "fetch-failed");
    }

    #[test]
    fn claude_local_tokens_sum_input_and_output_only() {
        let dir = scratch();
        std::fs::create_dir_all(dir.join(".claude")).expect("mkdir");
        std::fs::write(
            dir.join(".claude/stats-cache.json"),
            json!({ "modelUsage": {
                "a": { "inputTokens": 100, "outputTokens": 50, "cacheReadInputTokens": 9999 },
                "b": { "inputTokens": 10, "outputTokens": 0 }
            } })
            .to_string(),
        )
        .expect("write");
        assert_eq!(claude_local_tokens(&dir), Some(160));
        assert_eq!(claude_local_tokens(&dir.join("missing")), None);
    }

    #[test]
    fn claude_falls_back_to_a_recorded_session_limit() {
        let errors = claude_limit_errors([
            json!({ "provider": "claude-code-cli", "lastError": "Claude usage limit reached. Your limit resets 3pm (UTC)." }),
            json!({ "provider": "codex-cli", "lastError": "rate limit" }),
        ]);
        assert_eq!(errors.len(), 1);
        let snapshot = claude_snapshot_from(Vec::new(), Some(5), &errors);
        assert_eq!(snapshot["windows"][0]["usedPercent"], 100);
        assert_eq!(snapshot["windows"][0]["label"], "Resets 3pm (UTC)");
        assert!(snapshot.get("unavailableReason").is_none());
        // Real windows win over a recorded limit.
        let real = claude_snapshot_from(vec![json!({ "period": "hour" })], None, &errors);
        assert_eq!(real["windows"][0]["period"], "hour");
    }

    #[test]
    fn a_fixture_codex_app_server_is_read_end_to_end() {
        let dir = scratch();
        let script = dir.join("codex");
        std::fs::write(
            &script,
            r#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"initialize"'*) echo '{"jsonrpc":"2.0","id":1,"result":{}}' ;;
    *'rateLimits'*) echo '{"jsonrpc":"2.0","id":2,"result":{"rateLimits":{"primary":{"usedPercent":7,"windowDurationMins":300}}}}' ;;
    *'usage/read'*) echo '{"jsonrpc":"2.0","id":3,"result":{"summary":{"lifetimeTokens":123}}}' ;;
  esac
done
"#,
        )
        .expect("script");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
                .expect("chmod");
        }
        let (limits, usage) = codex_rpc(&script).expect("read");
        let snapshot = codex_snapshot_from(&limits, usage.as_ref());
        assert_eq!(snapshot["windows"][0]["usedPercent"], 7.0);
        assert_eq!(snapshot["totalTokens"], 123);
    }
}
