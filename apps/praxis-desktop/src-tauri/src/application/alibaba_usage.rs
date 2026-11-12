//! Alibaba Cloud Model Studio Coding Plan quota (5-hour, weekly and monthly request windows):
//! the Rust port of `alibabaCodingPlanUsage.ts` and `alibabaConsoleSession.ts`.
//!
//! Alibaba exposes no quota endpoint that accepts the plan's `sk-sp-` chat key. What works, and
//! what the console's own Coding Plan page calls, is `queryCodingPlanInstanceInfoV2` over the
//! console gateway, authenticated by a signed-in console session: its cookies plus the page's
//! `sec_token`. The person signs in once in a Praxis-owned window (the native shell opens it and
//! hands the cookies it sees to [`store_session`]); nothing is copied from their own browser.
//! The undocumented console API is reported as such: every failure is a reason, never a zero.

use std::sync::LazyLock;

use chrono::{DateTime, Local, NaiveDateTime, TimeZone, Utc};
use praxis_host::HostContext;
use regex::Regex;
use serde_json::{Map, Value, json};

use super::runtime;

/// The shell-owned session cookies, kept with the other credentials.
const SESSION_SECRET: &str = "ai-usage:alibaba-console-session";
/// Cookies that exist only once a console sign-in has completed.
const LOGIN_COOKIES: [&str; 3] = [
    "login_aliyunid_ticket",
    "login_aliyunid",
    "login_current_pk",
];
const QUOTA_API: &str = "zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2";
const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
pub const SIGN_IN_REASON: &str = "Sign in to the Alibaba Cloud console to show Coding Plan quota — Settings → AI Provider → this endpoint → Sign in to Alibaba Cloud.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Region {
    Intl,
    Cn,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hosts {
    pub gateway: String,
    pub rpc_base: String,
    pub dashboard: String,
    pub referer: String,
    domain: &'static str,
    site: &'static str,
    rpc_action: &'static str,
    commodity_code: &'static str,
    region_id: &'static str,
}

/// The console hosts for a region. `PRAXIS_ALIBABA_CONSOLE_ORIGIN` points every one of them at a
/// single origin; only the e2e suite sets it, to a mock console on loopback.
pub fn console_hosts(region: Region, origin_override: Option<&str>) -> Hosts {
    let base = match region {
        Region::Intl => Hosts {
            gateway: "https://modelstudio.console.alibabacloud.com".into(),
            rpc_base: "https://bailian-singapore-cs.alibabacloud.com".into(),
            dashboard: "https://modelstudio.console.alibabacloud.com/ap-southeast-1/?tab=coding-plan#/efm/coding_plan".into(),
            referer: "https://modelstudio.console.alibabacloud.com/ap-southeast-1/?tab=coding-plan".into(),
            domain: "modelstudio.console.alibabacloud.com",
            site: "MODELSTUDIO_ALIBABACLOUD",
            rpc_action: "IntlBroadScopeAspnGateway",
            commodity_code: "sfm_codingplan_public_intl",
            region_id: "ap-southeast-1",
        },
        Region::Cn => Hosts {
            gateway: "https://bailian.console.aliyun.com".into(),
            rpc_base: "https://bailian-cs.console.aliyun.com".into(),
            dashboard: "https://bailian.console.aliyun.com/cn-beijing/?tab=model#/efm/coding_plan".into(),
            referer: "https://bailian.console.aliyun.com/cn-beijing/?tab=model".into(),
            domain: "bailian.console.aliyun.com",
            site: "BAILIAN_ALIYUN",
            rpc_action: "BroadScopeAspnGateway",
            commodity_code: "sfm_codingplan_public_cn",
            region_id: "cn-beijing",
        },
    };
    match origin_override
        .map(|o| o.trim().trim_end_matches('/'))
        .filter(|o| !o.is_empty())
    {
        None => base,
        Some(origin) => Hosts {
            gateway: origin.into(),
            rpc_base: origin.into(),
            dashboard: format!("{origin}/coding-plan"),
            referer: format!("{origin}/coding-plan"),
            ..base
        },
    }
}

fn hosts_for(region: Region) -> Hosts {
    console_hosts(
        region,
        std::env::var("PRAXIS_ALIBABA_CONSOLE_ORIGIN")
            .ok()
            .as_deref(),
    )
}

/// The mainland plan is served from `coding.dashscope.aliyuncs.com`; everything else is international.
pub fn region_for_endpoint(base_url: &str) -> Region {
    match url::Url::parse(base_url) {
        Ok(parsed) if parsed.host_str() == Some("coding.dashscope.aliyuncs.com") => Region::Cn,
        _ => Region::Intl,
    }
}

pub fn quota_url(hosts: &Hosts) -> String {
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("action", hosts.rpc_action)
        .append_pair("product", "sfm_bailian")
        .append_pair("api", QUOTA_API)
        .append_pair("_v", "undefined")
        .finish();
    format!("{}/data/api.json?{query}", hosts.rpc_base)
}

pub fn quota_body(
    hosts: &Hosts,
    sec_token: &str,
    anonymous_id: Option<&str>,
    trace_id: &str,
) -> String {
    let mut cornerstone = json!({
        "feTraceId": trace_id, "feURL": hosts.dashboard, "protocol": "V2", "console": "ONE_CONSOLE", "productCode": "p_efm",
        "domain": hosts.domain, "consoleSite": hosts.site, "userNickName": "", "userPrincipalName": "", "xsp_lang": "en-US"
    });
    if let Some(id) = anonymous_id.filter(|id| !id.is_empty()) {
        cornerstone["X-Anonymous-Id"] = json!(id);
    }
    let params = json!({
        "Api": QUOTA_API, "V": "1.0",
        "Data": {
            "queryCodingPlanInstanceInfoRequest": { "commodityCode": hosts.commodity_code, "onlyLatestOne": true },
            "cornerstoneParam": cornerstone
        }
    });
    url::form_urlencoded::Serializer::new(String::new())
        .append_pair("params", &params.to_string())
        .append_pair("region", hosts.region_id)
        .append_pair("sec_token", sec_token)
        .finish()
}

// ---------------------------------------------------------------- parsing

/// The console wraps payloads in JSON-encoded strings; unwrap them before searching.
fn expand_embedded_json(value: &Value) -> Value {
    match value {
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.starts_with('{') || trimmed.starts_with('[') {
                serde_json::from_str::<Value>(trimmed)
                    .map_or_else(|_| value.clone(), |parsed| expand_embedded_json(&parsed))
            } else {
                value.clone()
            }
        }
        Value::Array(items) => Value::Array(items.iter().map(expand_embedded_json).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), expand_embedded_json(v)))
                .collect::<Map<_, _>>(),
        ),
        other => other.clone(),
    }
}

/// Breadth-first: the first value under any of `keys`, at any depth, that `accept` takes.
fn find_first<'a>(
    value: &'a Value,
    keys: &[&str],
    accept: impl Fn(&Value) -> bool,
) -> Option<&'a Value> {
    let wanted: Vec<String> = keys.iter().map(|k| k.to_lowercase()).collect();
    let mut queue = std::collections::VecDeque::from([value]);
    while let Some(current) = queue.pop_front() {
        match current {
            Value::Array(items) => queue.extend(items.iter()),
            Value::Object(map) => {
                for (key, nested) in map {
                    if wanted.contains(&key.to_lowercase()) && accept(nested) {
                        return Some(nested);
                    }
                }
                queue.extend(map.values());
            }
            _ => {}
        }
    }
    None
}

fn find_object_with_any_key<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Map<String, Value>> {
    let mut queue = std::collections::VecDeque::from([value]);
    while let Some(current) = queue.pop_front() {
        match current {
            Value::Array(items) => queue.extend(items.iter()),
            Value::Object(map) => {
                if keys.iter().any(|k| map.contains_key(*k)) {
                    return Some(map);
                }
                queue.extend(map.values());
            }
            _ => {}
        }
    }
    None
}

fn number_at(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64().filter(|n| n.is_finite()),
        Value::String(text) if !text.trim().is_empty() => {
            text.trim().parse::<f64>().ok().filter(|n| n.is_finite())
        }
        _ => None,
    }
}

fn string_at(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn first_of<T>(
    source: &Map<String, Value>,
    keys: &[&str],
    read: impl Fn(&Value) -> Option<T>,
) -> Option<T> {
    keys.iter().find_map(|key| source.get(*key).and_then(&read))
}

/// Epoch seconds or milliseconds, ISO, or the console's `yyyy-MM-dd HH:mm[:ss]`.
fn date_at(value: &Value) -> Option<DateTime<Utc>> {
    if let Some(numeric) = number_at(value).filter(|n| *n > 0.0) {
        let millis = if numeric >= 1e12 {
            numeric
        } else {
            numeric * 1000.0
        };
        return Utc.timestamp_millis_opt(millis as i64).single();
    }
    let text = string_at(value)?;
    if let Ok(parsed) = DateTime::parse_from_rfc3339(&text) {
        return Some(parsed.with_timezone(&Utc));
    }
    // The console's own format carries no zone; like `Date.parse`, read it as local time.
    [
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M",
    ]
    .iter()
    .find_map(|format| NaiveDateTime::parse_from_str(&text, format).ok())
    .and_then(|naive| Local.from_local_datetime(&naive).single())
    .map(|local| local.with_timezone(&Utc))
}

const INSTANCE_KEYS: [&str; 2] = ["codingPlanInstanceInfos", "coding_plan_instance_infos"];
const QUOTA_KEYS: [&str; 2] = ["codingPlanQuotaInfo", "coding_plan_quota_info"];
const QUOTA_FIELDS: [&str; 6] = [
    "per5HourUsedQuota",
    "per5HourTotalQuota",
    "perWeekUsedQuota",
    "perWeekTotalQuota",
    "perBillMonthUsedQuota",
    "perBillMonthTotalQuota",
];

fn active_score(instance: &Map<String, Value>, now: DateTime<Utc>) -> i32 {
    let status =
        first_of(instance, &["status", "instanceStatus"], string_at).map(|s| s.to_uppercase());
    match status.as_deref() {
        Some("VALID" | "ACTIVE") => return 3,
        Some("EXPIRED" | "INVALID" | "INACTIVE" | "DISABLED" | "TERMINATED" | "STOPPED") => {
            return -1;
        }
        _ => {}
    }
    let end = first_of(
        instance,
        &["endTime", "periodEndTime", "expireTime", "expirationTime"],
        date_at,
    );
    i32::from(end.is_some_and(|end| end > now))
}

/// The active plan when there are several (a lapsed trial alongside a paid plan).
fn active_instance(payload: &Value, now: DateTime<Utc>) -> Option<&Value> {
    let infos = find_first(payload, &INSTANCE_KEYS, Value::is_array)?.as_array()?;
    let instances: Vec<&Value> = infos.iter().filter(|info| info.is_object()).collect();
    let mut best = *instances.first()?;
    let mut best_score = active_score(best.as_object()?, now);
    for instance in &instances[1..] {
        let score = active_score(instance.as_object()?, now);
        if score > best_score {
            best = instance;
            best_score = score;
        }
    }
    Some(best)
}

fn quota_info<'a>(source: &'a Value) -> Option<&'a Map<String, Value>> {
    find_first(source, &QUOTA_KEYS, Value::is_object)
        .and_then(Value::as_object)
        .or_else(|| find_object_with_any_key(source, &QUOTA_FIELDS))
}

fn plan_name(instance: Option<&Value>, payload: &Value) -> Option<String> {
    if let Some(instance) = instance.and_then(Value::as_object)
        && let Some(name) = first_of(
            instance,
            &[
                "planName",
                "plan_name",
                "instanceName",
                "instance_name",
                "packageName",
                "package_name",
            ],
            string_at,
        )
    {
        return Some(name);
    }
    find_first(
        payload,
        &["planName", "plan_name", "packageName", "package_name"],
        |v| v.as_str().is_some_and(|s| !s.trim().is_empty()),
    )
    .and_then(string_at)
}

/// `1500` -> `1,500`.
fn count(n: f64) -> String {
    let digits = format!("{}", n.round() as i64);
    let (sign, digits) = digits
        .strip_prefix('-')
        .map_or(("", digits.as_str()), |rest| ("-", rest));
    let mut out = String::new();
    for (index, ch) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    format!("{sign}{out}")
}

struct WindowShape {
    period: &'static str,
    name: &'static str,
    duration_minutes: Option<u32>,
}

fn map_window(
    quota: &Map<String, Value>,
    used: &[&str],
    total: &[&str],
    reset: &[&str],
    shape: &WindowShape,
    now: DateTime<Utc>,
) -> Option<Value> {
    let used = first_of(quota, used, number_at)?;
    let total = first_of(quota, total, number_at).filter(|t| *t > 0.0)?;
    let clamped = used.clamp(0.0, total);
    let mut window = json!({
        "period": shape.period,
        // The card already names the endpoint; repeating the plan on three rows wrapped every label.
        "label": format!("{} · {} / {} requests", shape.name, count(clamped), count(total)),
        "usedPercent": ((clamped / total) * 100.0).round() as i64
    });
    if let Some(minutes) = shape.duration_minutes {
        window["windowDurationMinutes"] = json!(minutes);
    }
    // A reset already in the past is a stale figure, not a countdown.
    if let Some(reset) = first_of(quota, reset, date_at).filter(|r| *r > now) {
        window["resetsAt"] = json!(reset.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    }
    Some(window)
}

/// The console no longer accepts this session (or there never was one).
#[derive(Debug, PartialEq, Eq)]
pub struct LoginRequired;

fn snapshot(provider: &str, now: DateTime<Utc>, windows: Vec<Value>) -> Value {
    json!({ "provider": provider, "fetchedAt": now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true), "windows": windows })
}

fn unavailable(provider: &str, now: DateTime<Utc>, reason: &str, code: &str) -> Value {
    let mut value = snapshot(provider, now, Vec::new());
    value["unavailableReason"] = json!(reason);
    value["unavailableReasonCode"] = json!(code);
    value
}

/// Pure part of the adapter: the console's `queryCodingPlanInstanceInfoV2` payload -> a
/// provider-neutral snapshot. `Err(LoginRequired)` for a session the console refuses, so the caller
/// says "sign in" rather than "failed".
pub fn parse_coding_plan_quota(
    provider: &str,
    body: &Value,
    now: DateTime<Utc>,
) -> Result<Value, LoginRequired> {
    let failed = |reason: &str| Ok(unavailable(provider, now, reason, "fetch-failed"));
    let payload = expand_embedded_json(body);
    if !payload.is_object() {
        return failed("Alibaba returned a Coding Plan payload Praxis could not read.");
    }
    let code = find_first(&payload, &["code"], Value::is_string).and_then(string_at);
    let message = find_first(
        &payload,
        &["message", "msg", "statusMessage"],
        Value::is_string,
    )
    .and_then(string_at);
    static LOGIN: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)login|log ?in").expect("regex"));
    if code.as_deref().is_some_and(|c| LOGIN.is_match(c))
        || message.as_deref().is_some_and(|m| LOGIN.is_match(m))
    {
        return Err(LoginRequired);
    }
    if let Some(status) = find_first(&payload, &["statusCode", "status_code"], |v| {
        number_at(v).is_some()
    })
    .and_then(number_at)
        && status != 0.0
        && status != 200.0
    {
        return failed(&format!(
            "Alibaba Coding Plan request failed: {}",
            message.unwrap_or_else(|| format!("status {status}"))
        ));
    }

    let instance = active_instance(&payload, now);
    let quota = instance
        .and_then(quota_info)
        .or_else(|| quota_info(&payload));
    let plan = plan_name(instance, &payload);
    let Some(quota) = quota else {
        return failed(&plan.map_or_else(
            || "Alibaba did not report a Coding Plan for this account. A pay-as-you-go key has no plan quota.".to_owned(),
            |plan| format!("Alibaba reports {plan} but no quota counters for it."),
        ));
    };
    let windows: Vec<Value> = [
        map_window(
            quota,
            &["per5HourUsedQuota", "perFiveHourUsedQuota"],
            &["per5HourTotalQuota", "perFiveHourTotalQuota"],
            &[
                "per5HourQuotaNextRefreshTime",
                "perFiveHourQuotaNextRefreshTime",
            ],
            &WindowShape {
                period: "hour",
                name: "5-hour",
                duration_minutes: Some(300),
            },
            now,
        ),
        map_window(
            quota,
            &["perWeekUsedQuota"],
            &["perWeekTotalQuota"],
            &["perWeekQuotaNextRefreshTime"],
            &WindowShape {
                period: "week",
                name: "Weekly",
                duration_minutes: None,
            },
            now,
        ),
        map_window(
            quota,
            &["perBillMonthUsedQuota", "perMonthUsedQuota"],
            &["perBillMonthTotalQuota", "perMonthTotalQuota"],
            &[
                "perBillMonthQuotaNextRefreshTime",
                "perMonthQuotaNextRefreshTime",
            ],
            &WindowShape {
                period: "month",
                name: "Monthly",
                duration_minutes: None,
            },
            now,
        ),
    ]
    .into_iter()
    .flatten()
    .collect();
    if windows.is_empty() {
        return failed("Alibaba returned the Coding Plan without any usable quota windows.");
    }
    Ok(snapshot(provider, now, windows))
}

// ---------------------------------------------------------------- the console session

/// The console session's cookies, flattened to one `Cookie` header; `None` when never signed in.
pub fn cookie_header(host: &HostContext) -> Option<String> {
    let stored: Value = serde_json::from_str(&host.secrets().get(SESSION_SECRET)?).ok()?;
    let parts: Vec<String> = stored
        .as_array()?
        .iter()
        .filter_map(|c| Some(format!("{}={}", c["name"].as_str()?, c["value"].as_str()?)))
        .collect();
    (!parts.is_empty()).then(|| parts.join("; "))
}

pub fn is_signed_in(host: &HostContext) -> bool {
    cookie_header(host).is_some_and(|header| {
        LOGIN_COOKIES
            .iter()
            .any(|name| header.contains(&format!("{name}=")))
    })
}

/// Replaces the session with the cookies the sign-in window holds. Only names and values are kept.
pub fn store_session(host: &HostContext, cookies: &[Value]) {
    let kept: Vec<Value> = cookies
        .iter()
        .filter_map(|c| Some(json!({ "name": c["name"].as_str().filter(|n| !n.is_empty())?, "value": c["value"].as_str()? })))
        .collect();
    if kept.is_empty() {
        host.secrets().delete(SESSION_SECRET);
    } else {
        host.secrets()
            .set(SESSION_SECRET, &Value::Array(kept).to_string());
    }
}

pub fn sign_out(host: &HostContext) {
    host.secrets().delete(SESSION_SECRET);
}

pub fn cookie_value(header: &str, name: &str) -> Option<String> {
    header.split(';').find_map(|part| {
        let (key, value) = part.split_once('=')?;
        (key.trim() == name)
            .then(|| value.trim().to_owned())
            .filter(|v| !v.is_empty())
    })
}

/// The anti-CSRF token the console page embeds for its own RPC calls.
pub fn extract_sec_token(html: &str) -> Option<String> {
    static PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        [
            r#"SEC_TOKEN\s*:\s*"([^"]+)""#,
            r"SEC_TOKEN\s*:\s*'([^']+)'",
            r#"secToken\s*:\s*"([^"]+)""#,
            r#"sec_token\s*:\s*"([^"]+)""#,
            r"sec_token\s*:\s*'([^']+)'",
            r#""SEC_TOKEN"\s*:\s*"([^"]+)""#,
            r#""sec_token"\s*:\s*"([^"]+)""#,
        ]
        .iter()
        .map(|p| Regex::new(p).expect("regex"))
        .collect()
    });
    PATTERNS.iter().find_map(|pattern| {
        pattern
            .captures(html)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().trim().to_owned())
            .filter(|t| !t.is_empty())
    })
}

// ---------------------------------------------------------------- fetching

async fn resolve_sec_token(
    client: &reqwest::Client,
    hosts: &Hosts,
    cookie: &str,
) -> Result<String, LoginRequired> {
    if let Ok(page) = client
        .get(&hosts.dashboard)
        .header("Cookie", cookie)
        .header("User-Agent", BROWSER_USER_AGENT)
        .header("Accept", "text/html,*/*")
        .send()
        .await
        && page.status().is_success()
        && let Ok(html) = page.text().await
        && let Some(token) = extract_sec_token(&html)
    {
        return Ok(token);
    }
    if let Ok(info) = client
        .get(format!("{}/tool/user/info.json", hosts.gateway))
        .header("Cookie", cookie)
        .header("User-Agent", BROWSER_USER_AGENT)
        .header("Accept", "application/json")
        .header("Referer", format!("{}/", hosts.gateway))
        .send()
        .await
        && info.status().is_success()
        && let Ok(body) = info.json::<Value>().await
        && let Some(token) = find_first(
            &expand_embedded_json(&body),
            &["secToken", "sec_token"],
            Value::is_string,
        )
        .and_then(string_at)
    {
        return Ok(token);
    }
    cookie_value(cookie, "sec_token").ok_or(LoginRequired)
}

async fn fetch_once(
    host: &HostContext,
    provider: &str,
    region: Region,
) -> Result<Value, LoginRequired> {
    let cookie = cookie_header(host).ok_or(LoginRequired)?;
    let hosts = hosts_for(region);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|_| LoginRequired)?;
    let sec_token = resolve_sec_token(&client, &hosts, &cookie).await?;
    let csrf =
        cookie_value(&cookie, "login_aliyunid_csrf").or_else(|| cookie_value(&cookie, "csrf"));
    let mut request = client
        .post(quota_url(&hosts))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Accept", "*/*")
        .header("Cookie", &cookie)
        .header("X-Requested-With", "XMLHttpRequest")
        .header("User-Agent", BROWSER_USER_AGENT)
        .header("Origin", &hosts.gateway)
        .header("Referer", &hosts.referer);
    if let Some(csrf) = csrf {
        request = request
            .header("x-xsrf-token", &csrf)
            .header("x-csrf-token", &csrf);
    }
    let anonymous = cookie_value(&cookie, "cna");
    let response = request
        .body(quota_body(
            &hosts,
            &sec_token,
            anonymous.as_deref(),
            &uuid::Uuid::new_v4().to_string(),
        ))
        .send()
        .await;
    let Ok(response) = response else {
        return Ok(unavailable(
            provider,
            Utc::now(),
            "Alibaba Coding Plan usage is unavailable: the console could not be reached.",
            "fetch-failed",
        ));
    };
    let status = response.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(LoginRequired);
    }
    if !status.is_success() {
        return Ok(unavailable(
            provider,
            Utc::now(),
            &format!(
                "Alibaba Coding Plan usage request failed ({}).",
                status.as_u16()
            ),
            "fetch-failed",
        ));
    }
    match response.json::<Value>().await {
        Ok(body) => parse_coding_plan_quota(provider, &body, Utc::now()),
        Err(_) => Ok(unavailable(
            provider,
            Utc::now(),
            "Alibaba returned a Coding Plan payload Praxis could not read.",
            "fetch-failed",
        )),
    }
}

/// Reads Coding Plan quota for one endpoint through the signed-in console session.
pub fn usage_snapshot(host: &HostContext, provider: &str, base_url: &str) -> Value {
    match runtime::block_on(fetch_once(host, provider, region_for_endpoint(base_url))) {
        Ok(snapshot) => snapshot,
        Err(LoginRequired) => unavailable(provider, Utc::now(), SIGN_IN_REASON, "not-configured"),
    }
}

/// The saved endpoint built from the Coding Plan preset (so a host the person edited still matches).
pub fn endpoint_base_url(host: &HostContext, provider: &str) -> Option<String> {
    host.settings()
        .read()
        .ai
        .custom_providers
        .iter()
        .flatten()
        .find(|endpoint| {
            endpoint.id == provider && endpoint.preset_id.as_deref() == Some("alibaba-coding-plan")
        })
        .map(|endpoint| endpoint.base_url.clone())
}

/// Every saved Coding Plan endpoint: the providers whose quota the Overview can read.
pub fn endpoint_ids(host: &HostContext) -> Vec<String> {
    host.settings()
        .read()
        .ai
        .custom_providers
        .iter()
        .flatten()
        .filter(|endpoint| endpoint.preset_id.as_deref() == Some("alibaba-coding-plan"))
        .map(|endpoint| endpoint.id.clone())
        .collect()
}

/// The console hosts for a Coding Plan endpoint, as the sign-in window needs them.
pub fn sign_in_target(host: &HostContext, provider: &str) -> Option<Value> {
    let base_url = endpoint_base_url(host, provider)?;
    let region = region_for_endpoint(&base_url);
    let hosts = hosts_for(region);
    Some(
        json!({ "region": if region == Region::Cn { "cn" } else { "intl" }, "dashboard": hosts.dashboard, "gateway": hosts.gateway, "rpcBase": hosts.rpc_base }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(secs: i64) -> DateTime<Utc> {
        Utc.timestamp_opt(secs, 0).single().expect("time")
    }

    #[test]
    fn quota_windows_map_percent_label_and_future_resets() {
        let now = at(1_800_000_000);
        let reset = (now.timestamp() + 2 * 3600) * 1000;
        let data = json!({ "data": { "codingPlanInstanceInfos": [{ "planName": "Coding Plan Pro", "status": "VALID" }],
            "codingPlanQuotaInfo": { "per5HourUsedQuota": 1500, "per5HourTotalQuota": 6000, "per5HourQuotaNextRefreshTime": reset,
                "perWeekUsedQuota": 36000, "perWeekTotalQuota": 45000, "perWeekQuotaNextRefreshTime": (now.timestamp() - 5) * 1000,
                "perBillMonthUsedQuota": "27000", "perBillMonthTotalQuota": 90000 } } });
        // The console double-encodes: DataV2 is a JSON string inside the envelope.
        let body = json!({ "code": "200", "data": { "successResponse": true, "DataV2": data.to_string() } });
        let snapshot = parse_coding_plan_quota("custom:alibaba", &body, now).expect("signed in");
        let windows = snapshot["windows"].as_array().expect("windows");
        assert_eq!(
            windows
                .iter()
                .map(|w| (
                    w["period"].as_str().unwrap(),
                    w["usedPercent"].as_i64().unwrap()
                ))
                .collect::<Vec<_>>(),
            vec![("hour", 25), ("week", 80), ("month", 30)]
        );
        assert_eq!(windows[0]["label"], "5-hour · 1,500 / 6,000 requests");
        assert_eq!(windows[0]["windowDurationMinutes"], 300);
        assert!(windows[0]["resetsAt"].is_string());
        assert!(
            windows[1].get("resetsAt").is_none(),
            "a reset in the past is stale, not a countdown"
        );
        assert!(snapshot.get("unavailableReason").is_none());
    }

    #[test]
    fn a_refused_session_asks_to_sign_in_and_other_failures_say_what_failed() {
        let now = at(1_800_000_000);
        assert_eq!(
            parse_coding_plan_quota(
                "p",
                &json!({ "code": "ConsoleNeedLogin", "message": "Please log in" }),
                now
            ),
            Err(LoginRequired)
        );
        let none = parse_coding_plan_quota("p", &json!({ "code": "200", "data": {} }), now)
            .expect("snapshot");
        assert_eq!(none["unavailableReasonCode"], "fetch-failed");
        assert!(
            none["unavailableReason"]
                .as_str()
                .unwrap()
                .contains("did not report a Coding Plan")
        );
        let failed =
            parse_coding_plan_quota("p", &json!({ "statusCode": 500, "message": "boom" }), now)
                .expect("snapshot");
        assert_eq!(
            failed["unavailableReason"],
            "Alibaba Coding Plan request failed: boom"
        );
        // The active plan wins over a lapsed one.
        let two = json!({ "codingPlanInstanceInfos": [
            { "status": "EXPIRED", "codingPlanQuotaInfo": { "perWeekUsedQuota": 1, "perWeekTotalQuota": 10 } },
            { "status": "VALID", "codingPlanQuotaInfo": { "perWeekUsedQuota": 9, "perWeekTotalQuota": 10 } } ] });
        assert_eq!(
            parse_coding_plan_quota("p", &two, now).expect("snapshot")["windows"][0]["usedPercent"],
            90
        );
    }

    #[test]
    fn sec_token_cookies_regions_and_request_bodies() {
        assert_eq!(
            extract_sec_token(r#"<script>window.X = { SEC_TOKEN: "abc123" };</script>"#).as_deref(),
            Some("abc123")
        );
        assert_eq!(extract_sec_token("nothing here"), None);
        assert_eq!(
            cookie_value("a=1; cna=xyz; b=2", "cna").as_deref(),
            Some("xyz")
        );
        assert_eq!(
            region_for_endpoint("https://coding.dashscope.aliyuncs.com/v1"),
            Region::Cn
        );
        assert_eq!(
            region_for_endpoint("https://coding-intl.dashscope.aliyuncs.com"),
            Region::Intl
        );
        let hosts = console_hosts(Region::Intl, Some("http://127.0.0.1:9/"));
        assert_eq!(hosts.dashboard, "http://127.0.0.1:9/coding-plan");
        assert!(
            quota_url(&hosts)
                .starts_with("http://127.0.0.1:9/data/api.json?action=IntlBroadScopeAspnGateway")
        );
        let body = quota_body(&hosts, "tok", Some("anon"), "trace");
        let form: std::collections::BTreeMap<String, String> =
            url::form_urlencoded::parse(body.as_bytes())
                .into_owned()
                .collect();
        assert_eq!(form["sec_token"], "tok");
        assert_eq!(form["region"], "ap-southeast-1");
        assert!(form["params"].contains("\"X-Anonymous-Id\":\"anon\""));
        assert_eq!(count(1234567.0), "1,234,567");
    }
}
