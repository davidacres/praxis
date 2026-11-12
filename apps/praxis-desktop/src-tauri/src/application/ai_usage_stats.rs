//! The AI usage ledger and its aggregations. Ports `aiUsageLog.ts` and `aiUsageStats.ts` from
//! core, and `trackSessionUsage` from the retired Electron `aiUsageIpc.ts`.
//!
//! Events are kept as JSON in `ai-usage-log.json` under `praxis.aiUsageLog.v1`, oldest first,
//! with exactly the field names the renderer reads.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use chrono::{DateTime, Datelike, Duration, TimeZone, Timelike, Utc};
use serde_json::{Value, json};
use uuid::Uuid;

use super::storage::{encoded, parse, read, write_atomic};

const LOG_FILE: &str = "ai-usage-log.json";
const LOG_KEY: &str = "praxis.aiUsageLog.v1";
/// Oldest entries fall off past this so the log cannot grow without bound.
const MAX_EVENTS: usize = 20_000;

type Cache = Mutex<HashMap<PathBuf, Vec<Value>>>;

fn cache() -> &'static Cache {
    static CACHE: OnceLock<Cache> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// Every recorded event, oldest first.
pub fn list_events(dir: &Path) -> Vec<Value> {
    let mut all = cache()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    all.entry(dir.to_path_buf())
        .or_insert_with(|| load(dir))
        .clone()
}

fn load(dir: &Path) -> Vec<Value> {
    let path = dir.join(LOG_FILE);
    let Ok(Some(raw)) = read(&path) else {
        return Vec::new();
    };
    let Ok(document) = parse(&path, Some(&raw)) else {
        return Vec::new();
    };
    document
        .get(LOG_KEY)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn finite_non_zero(value: &Value) -> bool {
    value.as_f64().is_some_and(|n| n.is_finite() && n != 0.0)
}

/// True when an event reports something; empty no-op deltas are never logged.
fn has_reportable_usage(event: &Value) -> bool {
    finite_non_zero(&event["inputTokens"])
        || finite_non_zero(&event["outputTokens"])
        || finite_non_zero(&event["totalTokens"])
        || finite_non_zero(&event["cost"]["amount"])
}

fn record(dir: &Path, mut event: Value) {
    event["id"] = json!(Uuid::new_v4().to_string());
    if event["timestamp"].is_null() {
        event["timestamp"] = json!(Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    }
    let mut all = cache()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let events = all.entry(dir.to_path_buf()).or_insert_with(|| load(dir));
    events.push(event);
    if events.len() > MAX_EVENTS {
        let excess = events.len() - MAX_EVENTS;
        events.drain(..excess);
    }
    if let Ok(text) = encoded(&json!({ LOG_KEY: events })) {
        let _ = write_atomic(&dir.join(LOG_FILE), &text, false);
    }
}

#[derive(Default, Clone)]
struct Seen {
    total: f64,
    input: f64,
    output: f64,
    cost: f64,
    currency: Option<String>,
}

/// Logs the change in a session's running totals since the last time it was seen.
pub fn track_session(dir: &Path, session: &Value) {
    static SEEN: OnceLock<Mutex<HashMap<String, Seen>>> = OnceLock::new();
    let Some(session_id) = session["sessionId"].as_str() else {
        return;
    };
    let number = |value: &Value| value.as_f64().unwrap_or(0.0);
    let (total, input, output) = (
        number(&session["tokenUsage"]["totalTokens"]),
        number(&session["tokenUsage"]["inputTokens"]),
        number(&session["tokenUsage"]["outputTokens"]),
    );
    let (cost, currency) = (
        number(&session["cost"]["amount"]),
        session["cost"]["currency"].as_str().map(str::to_owned),
    );
    let previous = {
        let mut seen = SEEN
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let key = format!("{}\u{0}{session_id}", dir.display());
        let mut previous = seen.get(&key).cloned().unwrap_or_default();
        // Running totals only grow; a drop means the session restarted from zero.
        if total < previous.total || input < previous.input || output < previous.output {
            previous = Seen::default();
        }
        seen.insert(
            key,
            Seen {
                total,
                input,
                output,
                cost,
                currency: currency.clone(),
            },
        );
        previous
    };
    let currency_stable =
        previous.currency.is_none() || currency.is_none() || previous.currency == currency;
    let delta_cost = if currency_stable && currency.is_some() {
        cost - previous.cost
    } else {
        0.0
    };
    let delta = |now: f64, before: f64| (now - before != 0.0).then(|| json!(now - before));
    let mut event = json!({ "source": "session", "sessionId": session_id });
    for (field, value) in [
        ("provider", &session["provider"]),
        ("model", &session["model"]),
        ("workflowRunId", &session["workflowRunId"]),
        ("workflowNodeId", &session["workflowNodeId"]),
    ] {
        if !value.is_null() {
            event[field] = value.clone();
        }
    }
    for (field, value) in [
        ("inputTokens", delta(input, previous.input)),
        ("outputTokens", delta(output, previous.output)),
        ("totalTokens", delta(total, previous.total)),
    ] {
        if let Some(value) = value {
            event[field] = value;
        }
    }
    if delta_cost != 0.0
        && let Some(currency) = currency
    {
        event["cost"] = json!({ "amount": delta_cost, "currency": currency });
    }
    if has_reportable_usage(&event) {
        record(dir, event);
    }
}

// ── aggregation ──────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Granularity {
    Hour,
    Day,
    Week,
    Month,
}

impl Granularity {
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "hour" => Self::Hour,
            "day" => Self::Day,
            "week" => Self::Week,
            "month" => Self::Month,
            _ => return None,
        })
    }

    fn name(self) -> &'static str {
        match self {
            Self::Hour => "hour",
            Self::Day => "day",
            Self::Week => "week",
            Self::Month => "month",
        }
    }
}

fn utc(year: i32, month: u32, day: u32, hour: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(year, month, day, hour, 0, 0)
        .single()
        .unwrap_or_default()
}

pub fn period_start(date: DateTime<Utc>, granularity: Granularity) -> DateTime<Utc> {
    let day = utc(date.year(), date.month(), date.day(), 0);
    match granularity {
        Granularity::Hour => utc(date.year(), date.month(), date.day(), date.hour()),
        Granularity::Day => day,
        // Monday of the ISO week.
        Granularity::Week => day - Duration::days(i64::from(date.weekday().num_days_from_monday())),
        Granularity::Month => utc(date.year(), date.month(), 1, 0),
    }
}

fn shift_months(start: DateTime<Utc>, months: i32) -> DateTime<Utc> {
    let index = start.year() * 12 + start.month() as i32 - 1 + months;
    utc(
        index.div_euclid(12),
        (index.rem_euclid(12) + 1) as u32,
        1,
        0,
    )
}

fn next_start(start: DateTime<Utc>, granularity: Granularity) -> DateTime<Utc> {
    match granularity {
        Granularity::Hour => start + Duration::hours(1),
        Granularity::Day => start + Duration::days(1),
        Granularity::Week => start + Duration::days(7),
        Granularity::Month => shift_months(start, 1),
    }
}

fn previous_start(start: DateTime<Utc>, granularity: Granularity) -> DateTime<Utc> {
    match granularity {
        Granularity::Hour => start - Duration::hours(1),
        Granularity::Day => start - Duration::days(1),
        Granularity::Week => start - Duration::days(7),
        Granularity::Month => shift_months(start, -1),
    }
}

fn iso(date: DateTime<Utc>) -> String {
    date.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn event_time(event: &Value) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(event["timestamp"].as_str()?)
        .ok()
        .map(|t| t.with_timezone(&Utc))
}

fn tokens_of(event: &Value, field: &str) -> Option<f64> {
    event[field].as_f64()
}

fn cost_of(event: &Value) -> Option<(String, f64)> {
    let amount = event["cost"]["amount"].as_f64().filter(|a| a.is_finite())?;
    Some((
        event["cost"]["currency"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        amount,
    ))
}

/// Currency totals as `[{currency, amount}]`, largest first.
fn cost_list(cost: &BTreeMap<String, f64>) -> Value {
    let mut list: Vec<(&String, &f64)> = cost.iter().collect();
    list.sort_by(|a, b| b.1.partial_cmp(a.1).unwrap_or(std::cmp::Ordering::Equal));
    json!(
        list.into_iter()
            .map(|(currency, amount)| json!({ "currency": currency, "amount": amount }))
            .collect::<Vec<_>>()
    )
}

#[derive(Default)]
struct Bucket {
    total: f64,
    input: f64,
    output: f64,
    count: u64,
    cost: BTreeMap<String, f64>,
    models: BTreeMap<String, f64>,
    sources: BTreeMap<String, f64>,
}

pub fn series(
    events: &[Value],
    granularity: Granularity,
    periods_back: usize,
    reference: DateTime<Utc>,
    provider: Option<&str>,
) -> Vec<Value> {
    let mut starts = vec![period_start(reference, granularity)];
    for _ in 1..periods_back.max(1) {
        let earliest = previous_start(starts[0], granularity);
        starts.insert(0, earliest);
    }
    let range = (
        starts[0],
        next_start(*starts.last().unwrap_or(&starts[0]), granularity),
    );
    let mut buckets: BTreeMap<DateTime<Utc>, Bucket> = starts
        .iter()
        .map(|start| (*start, Bucket::default()))
        .collect();
    for event in events {
        if provider.is_some_and(|p| event["provider"].as_str() != Some(p)) {
            continue;
        }
        let Some(at) = event_time(event) else {
            continue;
        };
        if at < range.0 || at >= range.1 {
            continue;
        }
        let Some(bucket) = buckets.get_mut(&period_start(at, granularity)) else {
            continue;
        };
        bucket.count += 1;
        bucket.total += tokens_of(event, "totalTokens").unwrap_or(0.0);
        bucket.input += tokens_of(event, "inputTokens").unwrap_or(0.0);
        bucket.output += tokens_of(event, "outputTokens").unwrap_or(0.0);
        if let Some((currency, amount)) = cost_of(event) {
            *bucket.cost.entry(currency).or_default() += amount;
        }
        if let (Some(model), Some(total)) = (
            event["model"].as_str().filter(|m| !m.is_empty()),
            tokens_of(event, "totalTokens"),
        ) {
            *bucket.models.entry(model.to_owned()).or_default() += total;
        }
        *bucket
            .sources
            .entry(event["source"].as_str().unwrap_or("session").to_owned())
            .or_default() += tokens_of(event, "totalTokens").unwrap_or(0.0);
    }
    starts
        .iter()
        .map(|start| {
            let bucket = &buckets[start];
            let mut models: Vec<(&String, &f64)> = bucket.models.iter().collect();
            models.sort_by(|a, b| b.1.partial_cmp(a.1).unwrap_or(std::cmp::Ordering::Equal));
            json!({
                "periodStart": iso(*start),
                "totalTokens": bucket.total, "inputTokens": bucket.input, "outputTokens": bucket.output,
                "eventCount": bucket.count,
                "costByCurrency": cost_list(&bucket.cost),
                "byModel": models.into_iter().map(|(model, total)| json!({ "model": model, "totalTokens": total })).collect::<Vec<_>>(),
                "bySource": bucket.sources,
            })
        })
        .collect()
}

pub fn compare_latest_period(
    events: &[Value],
    granularity: Granularity,
    reference: DateTime<Utc>,
) -> Value {
    let both = series(events, granularity, 2, reference, None);
    let (previous, current) = (both[0].clone(), both[1].clone());
    let delta = current["totalTokens"].as_f64().unwrap_or(0.0)
        - previous["totalTokens"].as_f64().unwrap_or(0.0);
    let before = previous["totalTokens"].as_f64().unwrap_or(0.0);
    let mut result = json!({ "granularity": granularity.name(), "current": current, "previous": previous, "deltaTokens": delta });
    if before > 0.0 {
        result["deltaPercent"] = json!(delta / before * 100.0);
    }
    result
}

fn source_label(source: &str) -> &str {
    match source {
        "session" => "Sessions",
        "prompt-analysis" => "Prompt analysis",
        "prompt-calibration" => "Prompt calibration",
        "workflow-recommendation" => "Workflow agent recommendations",
        "workflow-template-recommendation" => "Workflow template recommendations",
        "workflow-model-recommendation" => "Workflow model recommendations",
        other => other,
    }
}

#[derive(Default)]
struct Entry {
    total: f64,
    input: f64,
    output: f64,
    count: u64,
    cost: BTreeMap<String, f64>,
}

#[derive(Default)]
struct Window {
    entry: Entry,
    models: BTreeMap<(String, String), (String, Option<String>, Entry)>,
    sources: BTreeMap<String, Entry>,
}

fn accumulate(window: &mut Window, event: &Value) {
    let tokens = tokens_of(event, "totalTokens").unwrap_or(0.0);
    let cost = cost_of(event);
    let add = |entry: &mut Entry| {
        entry.count += 1;
        entry.total += tokens;
        entry.input += tokens_of(event, "inputTokens").unwrap_or(0.0);
        entry.output += tokens_of(event, "outputTokens").unwrap_or(0.0);
        if let Some((currency, amount)) = &cost {
            *entry.cost.entry(currency.clone()).or_default() += amount;
        }
    };
    add(&mut window.entry);
    let model = event["model"]
        .as_str()
        .filter(|m| !m.is_empty())
        .unwrap_or("Unknown model")
        .to_owned();
    let provider = event["provider"].as_str().map(str::to_owned);
    let key = (provider.clone().unwrap_or_default(), model.clone());
    add(&mut window
        .models
        .entry(key)
        .or_insert_with(|| (model, provider, Entry::default()))
        .2);
    add(window
        .sources
        .entry(event["source"].as_str().unwrap_or("session").to_owned())
        .or_default());
}

fn finalize(window: &Window, peak: Option<Value>) -> Value {
    let total = window.entry.total;
    let share = |tokens: f64| if total > 0.0 { tokens / total } else { 0.0 };
    let mut models: Vec<&(String, Option<String>, Entry)> = window.models.values().collect();
    models.sort_by(|a, b| {
        b.2.total
            .partial_cmp(&a.2.total)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0))
    });
    let mut sources: Vec<(&String, &Entry)> = window.sources.iter().collect();
    sources.sort_by(|a, b| {
        b.1.total
            .partial_cmp(&a.1.total)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| source_label(a.0).cmp(source_label(b.0)))
    });
    let mut summary = json!({
        "totalTokens": total, "inputTokens": window.entry.input, "outputTokens": window.entry.output, "eventCount": window.entry.count,
        "costByCurrency": cost_list(&window.entry.cost),
        "models": models.into_iter().map(|(model, provider, entry)| {
            let mut value = json!({ "model": model, "totalTokens": entry.total, "tokenShare": share(entry.total), "eventCount": entry.count, "costByCurrency": cost_list(&entry.cost) });
            if let Some(provider) = provider { value["provider"] = json!(provider); }
            value
        }).collect::<Vec<_>>(),
        "sources": sources.into_iter().map(|(source, entry)| json!({
            "source": source, "label": source_label(source), "totalTokens": entry.total, "inputTokens": entry.input, "outputTokens": entry.output,
            "tokenShare": share(entry.total), "eventCount": entry.count, "costByCurrency": cost_list(&entry.cost),
        })).collect::<Vec<_>>(),
    });
    if let Some(peak) = peak {
        summary["peak"] = peak;
    }
    summary
}

type PeakMap = BTreeMap<DateTime<Utc>, f64>;

/// Busiest entry inside `[from, to)`; an earlier period wins a tie.
fn busiest(
    map: &PeakMap,
    granularity: Granularity,
    bounds: Option<(DateTime<Utc>, DateTime<Utc>)>,
) -> Option<Value> {
    let mut best: Option<(DateTime<Utc>, f64)> = None;
    for (key, tokens) in map {
        if bounds.is_some_and(|(from, to)| *key < from || *key >= to) || *tokens <= 0.0 {
            continue;
        }
        if best.is_none_or(|(_, top)| *tokens > top) {
            best = Some((*key, *tokens));
        }
    }
    best.map(|(key, tokens)| json!({ "periodStart": iso(key), "granularity": granularity.name(), "totalTokens": tokens }))
}

pub fn dashboard_summary(events: &[Value], reference: DateTime<Utc>) -> Value {
    let (day, week, month) = (
        period_start(reference, Granularity::Day),
        period_start(reference, Granularity::Week),
        period_start(reference, Granularity::Month),
    );
    let (day_end, week_end, month_end) = (
        next_start(day, Granularity::Day),
        next_start(week, Granularity::Week),
        next_start(month, Granularity::Month),
    );
    let (mut today, mut this_week, mut this_month, mut all) = (
        Window::default(),
        Window::default(),
        Window::default(),
        Window::default(),
    );
    let (mut hours, mut days, mut weeks, mut months) = (
        PeakMap::new(),
        PeakMap::new(),
        PeakMap::new(),
        PeakMap::new(),
    );
    let (mut first, mut last): (Option<DateTime<Utc>>, Option<DateTime<Utc>>) = (None, None);
    for event in events {
        let Some(at) = event_time(event) else {
            continue;
        };
        accumulate(&mut all, event);
        first = Some(first.map_or(at, |f| f.min(at)));
        last = Some(last.map_or(at, |l| l.max(at)));
        if at >= day && at < day_end {
            accumulate(&mut today, event);
        }
        if at >= week && at < week_end {
            accumulate(&mut this_week, event);
        }
        if at >= month && at < month_end {
            accumulate(&mut this_month, event);
        }
        let tokens = tokens_of(event, "totalTokens").unwrap_or(0.0);
        *hours
            .entry(period_start(at, Granularity::Hour))
            .or_default() += tokens;
        *days.entry(period_start(at, Granularity::Day)).or_default() += tokens;
        *weeks
            .entry(period_start(at, Granularity::Week))
            .or_default() += tokens;
        *months
            .entry(period_start(at, Granularity::Month))
            .or_default() += tokens;
    }
    let mut all_time = finalize(&all, busiest(&months, Granularity::Month, None));
    if let Some(first) = first {
        all_time["firstEventAt"] = json!(iso(first));
    }
    if let Some(last) = last {
        all_time["lastEventAt"] = json!(iso(last));
    }
    let mut highs = json!({});
    for (name, map, granularity) in [
        ("day", &days, Granularity::Day),
        ("week", &weeks, Granularity::Week),
        ("month", &months, Granularity::Month),
    ] {
        if let Some(peak) = busiest(map, granularity, None) {
            highs[name] = peak;
        }
    }
    json!({
        "generatedAt": iso(reference),
        "today": finalize(&today, busiest(&hours, Granularity::Hour, Some((day, day_end)))),
        "week": finalize(&this_week, busiest(&days, Granularity::Day, Some((week, week_end)))),
        "month": finalize(&this_month, busiest(&days, Granularity::Day, Some((month, month_end)))),
        "allTime": all_time,
        "highs": highs,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn event(at: &str, model: &str, total: u64) -> Value {
        json!({ "id": "e", "timestamp": at, "source": "session", "provider": "openai", "model": model, "inputTokens": total / 2, "outputTokens": total / 2, "totalTokens": total })
    }

    #[test]
    fn dashboard_buckets_today_week_and_month() {
        let now = Utc.with_ymd_and_hms(2026, 11, 12, 10, 30, 0).unwrap();
        let events = vec![
            event("2026-11-12T09:15:00.000Z", "a", 100),
            event("2026-11-10T09:15:00.000Z", "b", 50),
            event("2026-10-01T00:00:00.000Z", "a", 10),
        ];
        let summary = dashboard_summary(&events, now);
        assert_eq!(summary["today"]["totalTokens"], 100.0);
        assert_eq!(summary["week"]["totalTokens"], 150.0);
        assert_eq!(summary["month"]["totalTokens"], 150.0);
        assert_eq!(summary["allTime"]["totalTokens"], 160.0);
        assert_eq!(summary["today"]["models"][0]["model"], "a");
        assert_eq!(summary["highs"]["day"]["totalTokens"], 100.0);
    }

    #[test]
    fn series_zero_fills_and_compares() {
        let now = Utc.with_ymd_and_hms(2026, 11, 12, 10, 0, 0).unwrap();
        let events = vec![
            event("2026-11-12T09:00:00.000Z", "a", 100),
            event("2026-11-10T09:00:00.000Z", "a", 40),
        ];
        let buckets = series(&events, Granularity::Day, 3, now, None);
        assert_eq!(buckets.len(), 3);
        assert_eq!(buckets[1]["totalTokens"], 0.0);
        let compare = compare_latest_period(&events, Granularity::Day, now);
        assert_eq!(compare["deltaTokens"], 100.0);
        assert!(compare.get("deltaPercent").is_none());
        assert_eq!(
            series(&events, Granularity::Day, 3, now, Some("anthropic"))[2]["totalTokens"],
            0.0
        );
    }

    #[test]
    fn session_totals_are_logged_as_deltas() {
        let dir = std::env::temp_dir().join(format!("usage-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut session = json!({ "sessionId": "s1", "provider": "openai", "model": "m", "tokenUsage": { "inputTokens": 10, "outputTokens": 5, "totalTokens": 15 } });
        track_session(&dir, &session);
        session["tokenUsage"] = json!({ "inputTokens": 12, "outputTokens": 8, "totalTokens": 20 });
        track_session(&dir, &session);
        track_session(&dir, &session);
        let events = list_events(&dir);
        assert_eq!(events.len(), 2);
        assert_eq!(events[1]["totalTokens"], 5.0);
        assert!(dir.join(LOG_FILE).exists());
    }
}
