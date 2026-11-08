//! Cron-based schedule calculation and overdue run detection.
//!
//! Provides timezone-aware cron schedule evaluation using [`cron::Schedule`]
//! and [`chrono_tz::Tz`], with support for standard 5-, 6-, and 7-field cron
//! expressions, next occurrence calculation, and overdue run detection.

use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use cron::Schedule;
use std::str::FromStr;
use thiserror::Error;

/// Errors that can occur when parsing a cron schedule or timezone.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum CronScheduleError {
    #[error("Invalid cron expression: {0}")]
    InvalidExpression(String),
    #[error("Invalid timezone: {0}")]
    InvalidTimeZone(String),
}

/// A parsed cron schedule bound to a specific IANA timezone.
#[derive(Debug, Clone)]
pub struct CronSchedule {
    expression: String,
    schedule: Schedule,
    timezone: Tz,
}

impl CronSchedule {
    /// Creates a new `CronSchedule` from a cron expression and an IANA timezone string.
    ///
    /// Accepts standard 5-field cron expressions (`min hour dom month dow`),
    /// 6-field expressions (`sec min hour dom month dow`), and 7-field expressions
    /// (`sec min hour dom month dow year`).
    pub fn new(expression: &str, timezone_str: &str) -> Result<Self, CronScheduleError> {
        let timezone = timezone_str
            .parse::<Tz>()
            .map_err(|_| CronScheduleError::InvalidTimeZone(timezone_str.to_string()))?;

        Self::with_tz(expression, timezone)
    }

    /// Creates a new `CronSchedule` from a cron expression and a resolved `Tz`.
    pub fn with_tz(expression: &str, timezone: Tz) -> Result<Self, CronScheduleError> {
        let trimmed = expression.trim();
        let normalized = normalize_cron_expression(trimmed);

        let schedule = Schedule::from_str(&normalized)
            .map_err(|e| CronScheduleError::InvalidExpression(e.to_string()))?;

        Ok(Self {
            expression: expression.to_string(),
            schedule,
            timezone,
        })
    }

    /// The original expression string used to construct this schedule.
    #[must_use]
    pub fn expression(&self) -> &str {
        &self.expression
    }

    /// The resolved timezone for this schedule.
    #[must_use]
    pub fn timezone(&self) -> Tz {
        self.timezone
    }

    /// Calculates the next occurrence after `after_utc`.
    #[must_use]
    pub fn next_after(&self, after_utc: DateTime<Utc>) -> Option<DateTime<Utc>> {
        let zoned = after_utc.with_timezone(&self.timezone);
        self.schedule
            .after(&zoned)
            .next()
            .map(|dt| dt.with_timezone(&Utc))
    }

    /// Detects all overdue runs between `last_run_utc` and `now_utc`.
    ///
    /// If `last_run_utc >= now_utc`, returns an empty vector.
    /// Otherwise iterates through all scheduled occurrences strictly after
    /// `last_run_utc` and on or before `now_utc`.
    #[must_use]
    pub fn find_overdue_runs(
        &self,
        last_run_utc: DateTime<Utc>,
        now_utc: DateTime<Utc>,
    ) -> Vec<DateTime<Utc>> {
        if last_run_utc >= now_utc {
            return Vec::new();
        }

        let mut overdue = Vec::new();
        let mut cursor = last_run_utc;
        while let Some(next) = self.next_after(cursor) {
            if next <= now_utc {
                overdue.push(next);
                cursor = next;
            } else {
                break;
            }
        }
        overdue
    }
}

/// Normalizes a cron expression to the 6 or 7 fields expected by `cron::Schedule`.
///
/// If a standard 5-field expression is provided (`min hour dom month dow`),
/// `0 ` is prepended to specify seconds = 0, and `*` is appended if needed.
fn normalize_cron_expression(expr: &str) -> String {
    let fields: Vec<&str> = expr.split_whitespace().collect();
    match fields.len() {
        // Standard Unix 5 fields: min hour dom month dow -> prepend sec=0
        5 => format!("0 {expr} *"),
        // 6 fields: sec min hour dom month dow -> append year=*
        6 => format!("{expr} *"),
        // 7 fields: already sec min hour dom month dow year
        _ => expr.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn test_valid_5_field_expression() {
        // Run at 12:00 daily
        let cron = CronSchedule::new("0 12 * * *", "UTC").expect("valid 5-field cron");
        let start = Utc.with_ymd_and_hms(2026, 1, 1, 10, 0, 0).unwrap();
        let next = cron.next_after(start).expect("has next");
        assert_eq!(next, Utc.with_ymd_and_hms(2026, 1, 1, 12, 0, 0).unwrap());
    }

    #[test]
    fn test_valid_6_field_expression() {
        // Run at 12:00:30 daily
        let cron = CronSchedule::new("30 0 12 * * *", "UTC").expect("valid 6-field cron");
        let start = Utc.with_ymd_and_hms(2026, 1, 1, 10, 0, 0).unwrap();
        let next = cron.next_after(start).expect("has next");
        assert_eq!(next, Utc.with_ymd_and_hms(2026, 1, 1, 12, 0, 30).unwrap());
    }

    #[test]
    fn test_valid_7_field_expression() {
        // Run at 12:00:00 daily in year 2026
        let cron = CronSchedule::new("0 0 12 * * * 2026", "UTC").expect("valid 7-field cron");
        let start = Utc.with_ymd_and_hms(2026, 1, 1, 10, 0, 0).unwrap();
        let next = cron.next_after(start).expect("has next");
        assert_eq!(next, Utc.with_ymd_and_hms(2026, 1, 1, 12, 0, 0).unwrap());
    }

    #[test]
    fn test_invalid_cron_expression() {
        let res = CronSchedule::new("invalid cron expr", "UTC");
        assert!(matches!(res, Err(CronScheduleError::InvalidExpression(_))));
    }

    #[test]
    fn test_invalid_timezone() {
        let res = CronSchedule::new("0 12 * * *", "Not/A/Timezone");
        assert!(matches!(res, Err(CronScheduleError::InvalidTimeZone(_))));
    }

    #[test]
    fn test_timezone_conversion() {
        // Run at 09:30 America/New_York (UTC-5 in winter)
        let cron = CronSchedule::new("30 9 * * *", "America/New_York").expect("valid cron");
        let start = Utc.with_ymd_and_hms(2026, 1, 15, 12, 0, 0).unwrap(); // 12:00 UTC = 07:00 EST
        let next = cron.next_after(start).expect("has next");
        // 09:30 EST is 14:30 UTC
        assert_eq!(next, Utc.with_ymd_and_hms(2026, 1, 15, 14, 30, 0).unwrap());
    }

    #[test]
    fn test_find_overdue_runs() {
        // Run every hour at minute 0
        let cron = CronSchedule::new("0 * * * *", "UTC").expect("valid cron");
        let last_run = Utc.with_ymd_and_hms(2026, 1, 1, 10, 0, 0).unwrap();
        let now = Utc.with_ymd_and_hms(2026, 1, 1, 13, 30, 0).unwrap();

        let overdue = cron.find_overdue_runs(last_run, now);
        assert_eq!(overdue.len(), 3);
        assert_eq!(
            overdue[0],
            Utc.with_ymd_and_hms(2026, 1, 1, 11, 0, 0).unwrap()
        );
        assert_eq!(
            overdue[1],
            Utc.with_ymd_and_hms(2026, 1, 1, 12, 0, 0).unwrap()
        );
        assert_eq!(
            overdue[2],
            Utc.with_ymd_and_hms(2026, 1, 1, 13, 0, 0).unwrap()
        );
    }

    #[test]
    fn test_find_overdue_runs_none_when_last_run_is_now_or_future() {
        let cron = CronSchedule::new("0 * * * *", "UTC").expect("valid cron");
        let now = Utc.with_ymd_and_hms(2026, 1, 1, 10, 0, 0).unwrap();

        assert!(cron.find_overdue_runs(now, now).is_empty());

        let future = Utc.with_ymd_and_hms(2026, 1, 1, 11, 0, 0).unwrap();
        assert!(cron.find_overdue_runs(future, now).is_empty());
    }

    #[test]
    fn test_step_and_list_expressions() {
        // Every 15 minutes
        let cron = CronSchedule::new("*/15 * * * *", "UTC").expect("valid cron");
        let start = Utc.with_ymd_and_hms(2026, 3, 10, 8, 1, 0).unwrap();
        let next = cron.next_after(start).expect("has next");
        assert_eq!(next, Utc.with_ymd_and_hms(2026, 3, 10, 8, 15, 0).unwrap());

        // Mon-Fri at 9am and 5pm (cron crate uses 1=Sun, 2=Mon, ..., 6=Fri, 7=Sat or MON-FRI)
        let cron_biz = CronSchedule::new("0 9,17 * * Mon-Fri", "UTC").expect("valid cron");
        // 2026-03-06 is Friday
        let friday_noon = Utc.with_ymd_and_hms(2026, 3, 6, 12, 0, 0).unwrap();
        let friday_5pm = cron_biz.next_after(friday_noon).expect("has next");
        assert_eq!(
            friday_5pm,
            Utc.with_ymd_and_hms(2026, 3, 6, 17, 0, 0).unwrap()
        );

        // Next after Friday 5pm is Monday 9am (2026-03-09)
        let monday_9am = cron_biz.next_after(friday_5pm).expect("has next");
        assert_eq!(
            monday_9am,
            Utc.with_ymd_and_hms(2026, 3, 9, 9, 0, 0).unwrap()
        );
    }

    #[test]
    fn test_accessors_and_with_tz() {
        let expr = "0 12 * * *";
        let tz: Tz = chrono_tz::Asia::Tokyo;
        let cron = CronSchedule::with_tz(expr, tz).expect("valid schedule");

        assert_eq!(cron.expression(), expr);
        assert_eq!(cron.timezone(), tz);

        let start = Utc.with_ymd_and_hms(2026, 5, 1, 0, 0, 0).unwrap(); // 09:00 JST
        let next = cron.next_after(start).expect("has next");
        // 12:00 JST is 03:00 UTC
        assert_eq!(next, Utc.with_ymd_and_hms(2026, 5, 1, 3, 0, 0).unwrap());
    }

    #[test]
    fn test_past_year_returns_none() {
        // Year 2020 in the past
        let cron = CronSchedule::new("0 0 12 1 1 * 2020", "UTC").expect("valid cron");
        let start = Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap();
        assert!(cron.next_after(start).is_none());
        assert!(
            cron.find_overdue_runs(start, Utc.with_ymd_and_hms(2026, 2, 1, 0, 0, 0).unwrap())
                .is_empty()
        );
    }

    #[test]
    fn test_find_overdue_runs_boundary_inclusive() {
        // Run at minute 0
        let cron = CronSchedule::new("0 * * * *", "UTC").expect("valid cron");
        // last_run at 10:00:00 (exact match)
        let last_run = Utc.with_ymd_and_hms(2026, 1, 1, 10, 0, 0).unwrap();
        // now at 12:00:00 (exact match)
        let now = Utc.with_ymd_and_hms(2026, 1, 1, 12, 0, 0).unwrap();

        let overdue = cron.find_overdue_runs(last_run, now);
        // Should NOT include 10:00 (since it was already run), but SHOULD include 11:00 and 12:00
        assert_eq!(overdue.len(), 2);
        assert_eq!(
            overdue[0],
            Utc.with_ymd_and_hms(2026, 1, 1, 11, 0, 0).unwrap()
        );
        assert_eq!(
            overdue[1],
            Utc.with_ymd_and_hms(2026, 1, 1, 12, 0, 0).unwrap()
        );
    }
}
