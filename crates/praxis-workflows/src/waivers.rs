//! Finding waivers: validation, activity, filtering, and org/project composition
//! (`waiverRegister.ts` port).

use std::collections::HashSet;

use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::types::CheckFinding;

/// A time-boxed, attributed exemption for one finding fingerprint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindingWaiver {
    pub fingerprint: String,
    pub reason: String,
    pub actor: String,
    pub created_at: String,
    pub expires_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot_ref: Option<String>,
}

/// A set of waivers with an optional lifetime ceiling.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaiverRegister {
    pub waivers: Vec<FindingWaiver>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_lifetime_days: Option<f64>,
}

/// Parses the date forms `Date.parse` accepts in practice: RFC 3339 / ISO 8601 with an
/// offset, a bare `YYYY-MM-DD` (UTC midnight), or a zone-less date-time (read as UTC).
#[must_use]
pub fn parse_iso_date(value: &str) -> Option<DateTime<Utc>> {
    let value = value.trim();
    if let Ok(parsed) = DateTime::parse_from_rfc3339(value) {
        return Some(parsed.with_timezone(&Utc));
    }
    if let Ok(date) = NaiveDate::parse_from_str(value, "%Y-%m-%d") {
        return date.and_hms_opt(0, 0, 0).map(|dt| dt.and_utc());
    }
    ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M"]
        .iter()
        .find_map(|format| NaiveDateTime::parse_from_str(value, format).ok())
        .map(|dt| dt.and_utc())
}

fn blank(value: &str) -> bool {
    value.trim().is_empty()
}

/// Rejects a waiver missing required fields, with a non-positive lifetime, or one that
/// exceeds `max_lifetime_days`.
pub fn validate_finding_waiver(
    waiver: &FindingWaiver,
    max_lifetime_days: Option<f64>,
) -> Result<(), String> {
    if blank(&waiver.fingerprint) {
        return Err("Waiver fingerprint is required.".to_string());
    }
    if blank(&waiver.reason) {
        return Err("Waiver reason is required and cannot be blank.".to_string());
    }
    if blank(&waiver.actor) {
        return Err("Waiver actor is required and cannot be blank.".to_string());
    }
    let created = parse_iso_date(&waiver.created_at)
        .ok_or_else(|| "Waiver createdAt must be a valid ISO date.".to_string())?;
    let expires = parse_iso_date(&waiver.expires_at)
        .ok_or_else(|| "Waiver expiresAt must be a valid ISO date.".to_string())?;
    if expires <= created {
        return Err("Waiver expiresAt must be in the future relative to createdAt.".to_string());
    }
    if let Some(max_days) = max_lifetime_days {
        #[allow(clippy::cast_precision_loss)]
        let lifetime_days = (expires - created).num_milliseconds() as f64 / 86_400_000.0;
        if lifetime_days > max_days {
            return Err(format!(
                "Waiver lifetime ({lifetime_days:.1} days) exceeds maximum allowed lifetime of {max_days} days."
            ));
        }
    }
    Ok(())
}

/// Whether a waiver applies at `now` (defaults to the current time) and, when it is bound
/// to a snapshot, whether that snapshot is `current_snapshot_ref`.
#[must_use]
pub fn is_waiver_active(
    waiver: &FindingWaiver,
    now: Option<DateTime<Utc>>,
    current_snapshot_ref: Option<&str>,
) -> bool {
    let now = now.unwrap_or_else(Utc::now);
    // An unparseable expiry compares false in JS, so it never counts as expired.
    if parse_iso_date(&waiver.expires_at).is_some_and(|expires| now >= expires) {
        return false;
    }
    match &waiver.snapshot_ref {
        Some(bound) => current_snapshot_ref == Some(bound.as_str()),
        None => true,
    }
}

/// Splits findings into those still active and those suppressed by an active waiver.
#[must_use]
pub fn filter_unwaived_findings(
    findings: &[CheckFinding],
    waivers: &[FindingWaiver],
    now: Option<DateTime<Utc>>,
    current_snapshot_ref: Option<&str>,
) -> (Vec<CheckFinding>, Vec<CheckFinding>) {
    let now = Some(now.unwrap_or_else(Utc::now));
    let waived: HashSet<&str> = waivers
        .iter()
        .filter(|waiver| is_waiver_active(waiver, now, current_snapshot_ref))
        .map(|waiver| waiver.fingerprint.as_str())
        .collect();
    findings
        .iter()
        .cloned()
        .partition(|finding| !waived.contains(finding.fingerprint.as_str()))
}

/// Composes org and project registers with strictest-wins lifetime semantics. A project may
/// tighten `max_lifetime_days` but never loosen it past the org ceiling.
pub fn compose_waiver_registers(
    org: Option<&WaiverRegister>,
    project: Option<&WaiverRegister>,
) -> Result<WaiverRegister, String> {
    let (org, project) = match (org, project) {
        (None, project) => return Ok(project.cloned().unwrap_or_default()),
        (Some(org), None) => return Ok(org.clone()),
        (Some(org), Some(project)) => (org, project),
    };

    let mut effective = org.max_lifetime_days;
    if let Some(project_max) = project.max_lifetime_days {
        if let Some(org_max) = org.max_lifetime_days
            && project_max > org_max
        {
            return Err(format!(
                "Project waiver maxLifetimeDays ({project_max}) exceeds organization ceiling ({org_max})."
            ));
        }
        effective = Some(
            org.max_lifetime_days
                .map_or(project_max, |org_max| org_max.min(project_max)),
        );
    }

    for waiver in &project.waivers {
        validate_finding_waiver(waiver, effective)?;
    }

    // Later entries replace earlier ones with the same key but keep the first position,
    // like a JS `Map`.
    let mut merged: Vec<FindingWaiver> = Vec::new();
    for waiver in org.waivers.iter().chain(&project.waivers) {
        let same_key = |existing: &FindingWaiver| {
            existing.fingerprint == waiver.fingerprint
                && existing.snapshot_ref == waiver.snapshot_ref
        };
        match merged.iter_mut().find(|existing| same_key(existing)) {
            Some(slot) => *slot = waiver.clone(),
            None => merged.push(waiver.clone()),
        }
    }

    Ok(WaiverRegister {
        waivers: merged,
        max_lifetime_days: effective,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::CheckFindingSeverity;

    fn waiver(created: &str, expires: &str) -> FindingWaiver {
        FindingWaiver {
            fingerprint: "fp1".to_string(),
            reason: "ok".to_string(),
            actor: "alice".to_string(),
            created_at: created.to_string(),
            expires_at: expires.to_string(),
            snapshot_ref: None,
        }
    }

    fn at(value: &str) -> Option<DateTime<Utc>> {
        parse_iso_date(value)
    }

    fn finding(fingerprint: &str) -> CheckFinding {
        CheckFinding {
            fingerprint: fingerprint.to_string(),
            rule_id: None,
            file: None,
            line: None,
            severity: CheckFindingSeverity::High,
            category: "security".to_string(),
            message: "m".to_string(),
            suggestion: None,
            verdict: None,
            verdict_reason: None,
        }
    }

    #[test]
    fn validate_rejects_missing_or_blank_required_fields() {
        let base = waiver("2026-09-01T00:00:00Z", "2026-09-10T00:00:00Z");
        let cases: [(FindingWaiver, &str); 4] = [
            (
                FindingWaiver {
                    fingerprint: String::new(),
                    ..base.clone()
                },
                "fingerprint is required",
            ),
            (
                FindingWaiver {
                    reason: "   ".to_string(),
                    ..base.clone()
                },
                "reason is required",
            ),
            (
                FindingWaiver {
                    actor: String::new(),
                    ..base.clone()
                },
                "actor is required",
            ),
            (
                waiver("2026-09-10T00:00:00Z", "2026-09-01T00:00:00Z"),
                "expiresAt must be in the future",
            ),
        ];
        for (candidate, expected) in cases {
            let err = validate_finding_waiver(&candidate, None).expect_err(expected);
            assert!(err.contains(expected), "{err}");
        }
        let bad_date = waiver("yesterday", "2026-09-10T00:00:00Z");
        assert!(validate_finding_waiver(&bad_date, None).is_err());
    }

    #[test]
    fn validate_enforces_max_lifetime_days() {
        let fifteen_days = waiver("2026-09-01T00:00:00Z", "2026-09-16T00:00:00Z");
        assert!(validate_finding_waiver(&fifteen_days, Some(30.0)).is_ok());
        let err = validate_finding_waiver(&fifteen_days, Some(10.0)).expect_err("too long");
        assert!(
            err.contains("exceeds maximum allowed lifetime of 10 days"),
            "{err}"
        );
        assert!(err.contains("(15.0 days)"), "{err}");
    }

    #[test]
    fn active_respects_expiration() {
        let w = waiver("2026-09-01T00:00:00Z", "2026-09-10T00:00:00Z");
        assert!(is_waiver_active(&w, at("2026-09-05T00:00:00Z"), None));
        assert!(!is_waiver_active(&w, at("2026-09-10T00:00:00Z"), None));
        assert!(!is_waiver_active(&w, at("2026-09-15T00:00:00Z"), None));
    }

    #[test]
    fn active_respects_snapshot_binding() {
        let w = FindingWaiver {
            snapshot_ref: Some("commit-sha-123".to_string()),
            ..waiver("2026-09-01T00:00:00Z", "2026-09-10T00:00:00Z")
        };
        let now = at("2026-09-05T00:00:00Z");
        assert!(is_waiver_active(&w, now, Some("commit-sha-123")));
        assert!(!is_waiver_active(&w, now, Some("commit-sha-999")));
        assert!(!is_waiver_active(&w, now, None));
    }

    #[test]
    fn filter_splits_out_findings_with_active_waivers() {
        let w = FindingWaiver {
            fingerprint: "fp-critical-1".to_string(),
            ..waiver("2026-09-01T00:00:00Z", "2026-09-10T00:00:00Z")
        };
        let (active, waived) = filter_unwaived_findings(
            &[finding("fp-critical-1"), finding("fp-high-2")],
            &[w],
            at("2026-09-05T00:00:00Z"),
            None,
        );
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].fingerprint, "fp-high-2");
        assert_eq!(waived.len(), 1);
        assert_eq!(waived[0].fingerprint, "fp-critical-1");
    }

    #[test]
    fn compose_is_strictest_wins_and_dedupes_by_fingerprint_and_snapshot() {
        let org = WaiverRegister {
            waivers: vec![],
            max_lifetime_days: Some(30.0),
        };
        let valid = WaiverRegister {
            waivers: vec![],
            max_lifetime_days: Some(14.0),
        };
        let invalid = WaiverRegister {
            waivers: vec![],
            max_lifetime_days: Some(60.0),
        };
        assert_eq!(
            compose_waiver_registers(Some(&org), Some(&valid))
                .expect("compose")
                .max_lifetime_days,
            Some(14.0)
        );
        let err = compose_waiver_registers(Some(&org), Some(&invalid)).expect_err("loosened");
        assert!(err.contains("exceeds organization ceiling"), "{err}");

        let org_waiver = waiver("2026-09-01T00:00:00Z", "2026-09-05T00:00:00Z");
        let project_waiver = FindingWaiver {
            actor: "bob".to_string(),
            ..org_waiver.clone()
        };
        let composed = compose_waiver_registers(
            Some(&WaiverRegister {
                waivers: vec![org_waiver],
                max_lifetime_days: None,
            }),
            Some(&WaiverRegister {
                waivers: vec![project_waiver],
                max_lifetime_days: None,
            }),
        )
        .expect("compose");
        assert_eq!(composed.waivers.len(), 1);
        assert_eq!(composed.waivers[0].actor, "bob");
        assert_eq!(
            compose_waiver_registers(None, None).expect("empty"),
            WaiverRegister::default()
        );
    }

    #[test]
    fn parses_date_only_and_offset_forms() {
        assert_eq!(at("2026-09-01"), at("2026-09-01T00:00:00Z"));
        assert_eq!(
            at("2026-09-01T02:00:00+02:00"),
            at("2026-09-01T00:00:00.000Z")
        );
        assert_eq!(at("garbage"), None);
    }
}
