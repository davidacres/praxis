//! Wall-clock <-> instant conversion for a scheduled run's start (`scheduledRunTime.ts` port).
//!
//! A schedule stores one absolute instant. The editor works in a date, a time and a zone.
//! Two awkward cases are explicit. A wall time that does not exist (clocks go forward) has no
//! instant. A wall time that happens twice (clocks go back) resolves to the first occurrence.

use chrono::{DateTime, Datelike, NaiveDate, NaiveDateTime, NaiveTime, Offset, Timelike, Utc};
use chrono_tz::Tz;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// `YYYY-MM-DD` and `HH:mm`, the editor's wall-clock form.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZonedParts {
    pub date: String,
    pub time: String,
}

/// True for an IANA zone this runtime knows.
#[must_use]
pub fn is_valid_time_zone(timezone: &str) -> bool {
    parse_zone(timezone).is_some()
}

fn parse_zone(timezone: &str) -> Option<Tz> {
    if timezone.is_empty() {
        return None;
    }
    timezone.parse::<Tz>().ok()
}

/// The wall-clock fields `timezone` shows at that UTC millisecond.
fn wall_naive(utc_ms: i64, zone: Tz) -> Option<NaiveDateTime> {
    let instant: DateTime<Utc> = DateTime::from_timestamp_millis(utc_ms)?;
    Some(instant.with_timezone(&zone).naive_local())
}

/// How far `zone` is ahead of UTC at that instant, in ms.
fn offset_ms(utc_ms: i64, zone: Tz) -> Option<i64> {
    let instant: DateTime<Utc> = DateTime::from_timestamp_millis(utc_ms)?;
    let seconds = instant
        .with_timezone(&zone)
        .offset()
        .fix()
        .local_minus_utc();
    Some(i64::from(seconds) * 1000)
}

/// Formats an instant's wall clock in `timezone` as `YYYY-MM-DD` and `HH:mm`.
#[must_use]
pub fn instant_to_zoned_parts(instant: &str, timezone: &str) -> Option<ZonedParts> {
    let ms = DateTime::parse_from_rfc3339(instant)
        .ok()?
        .timestamp_millis();
    let zone = parse_zone(timezone)?;
    let wall = wall_naive(ms, zone)?;
    Some(ZonedParts {
        date: format!("{:04}-{:02}-{:02}", wall.year(), wall.month(), wall.day()),
        time: format!("{:02}:{:02}", wall.hour(), wall.minute()),
    })
}

fn parse_date(date: &str) -> Option<NaiveDate> {
    let bytes = date.as_bytes();
    let well_formed = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && date
            .char_indices()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit());
    if !well_formed {
        return None;
    }
    NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()
}

fn parse_time(time: &str) -> Option<NaiveTime> {
    let bytes = time.as_bytes();
    let well_formed = bytes.len() == 5
        && bytes[2] == b':'
        && time
            .char_indices()
            .all(|(i, c)| i == 2 || c.is_ascii_digit());
    if !well_formed {
        return None;
    }
    NaiveTime::parse_from_str(time, "%H:%M").ok()
}

/// The ISO instant for a wall-clock date and time in `timezone`. `None` when the input is
/// malformed, the zone is unknown, or the wall time does not exist in that zone.
#[must_use]
pub fn zoned_time_to_instant(date: &str, time: &str, timezone: &str) -> Option<String> {
    let date = parse_date(date)?;
    let time = parse_time(time)?;
    let zone = parse_zone(timezone)?;
    let wanted = NaiveDateTime::new(date, time);
    let as_if_utc = wanted.and_utc().timestamp_millis();

    // The offset a day either side brackets any change that could land on this wall time.
    let candidates = [
        as_if_utc - offset_ms(as_if_utc - DAY_MS, zone)?,
        as_if_utc - offset_ms(as_if_utc + DAY_MS, zone)?,
    ];
    let mut valid: Vec<i64> = candidates
        .into_iter()
        .filter(|ms| wall_naive(*ms, zone).is_some_and(|wall| wall == wanted))
        .collect();
    valid.sort_unstable();
    let first = valid.first()?;
    DateTime::from_timestamp_millis(*first)
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wall_time_round_trips_through_an_instant() {
        let instant =
            zoned_time_to_instant("2026-10-21", "22:00", "Europe/London").expect("instant");
        assert_eq!(instant, "2026-10-21T21:00:00.000Z");
        assert_eq!(
            instant_to_zoned_parts(&instant, "Europe/London"),
            Some(ZonedParts {
                date: "2026-10-21".into(),
                time: "22:00".into()
            })
        );
        assert_eq!(
            instant_to_zoned_parts(&instant, "America/New_York"),
            Some(ZonedParts {
                date: "2026-10-21".into(),
                time: "17:00".into()
            })
        );
        assert_eq!(
            zoned_time_to_instant("2026-01-15", "09:30", "Asia/Kolkata").as_deref(),
            Some("2026-01-15T04:00:00.000Z")
        );
    }

    #[test]
    fn a_wall_time_skipped_by_clocks_going_forward_has_no_instant() {
        assert_eq!(
            zoned_time_to_instant("2027-03-28", "01:30", "Europe/London"),
            None
        );
        assert_eq!(
            zoned_time_to_instant("2027-03-28", "02:30", "Europe/London").as_deref(),
            Some("2027-03-28T01:30:00.000Z")
        );
    }

    #[test]
    fn a_wall_time_repeated_by_clocks_going_back_resolves_to_the_first_occurrence() {
        assert_eq!(
            zoned_time_to_instant("2026-10-25", "01:30", "Europe/London").as_deref(),
            Some("2026-10-25T00:30:00.000Z")
        );
    }

    #[test]
    fn invalid_dates_times_and_zones_return_none() {
        assert_eq!(zoned_time_to_instant("2026-02-31", "10:00", "UTC"), None);
        assert_eq!(zoned_time_to_instant("2026-13-01", "10:00", "UTC"), None);
        assert_eq!(zoned_time_to_instant("2026-10-21", "25:00", "UTC"), None);
        assert_eq!(
            zoned_time_to_instant("2026-10-21", "10:00", "Mars/Olympus"),
            None
        );
        assert_eq!(zoned_time_to_instant("21/10/2026", "10:00", "UTC"), None);
        assert_eq!(instant_to_zoned_parts("garbage", "UTC"), None);
    }

    #[test]
    fn zone_validity_follows_the_iana_database() {
        assert!(is_valid_time_zone("Europe/London"));
        assert!(is_valid_time_zone("UTC"));
        assert!(!is_valid_time_zone(""));
        assert!(!is_valid_time_zone("Mars/Olympus"));
    }
}
