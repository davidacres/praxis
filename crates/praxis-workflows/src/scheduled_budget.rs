//! Which AI provider a scheduled ticket may run on, given how much allowance each has used
//! (`scheduledBudget.ts` port).
//!
//! Pure: the caller supplies the figures. Two things shape the answer:
//!
//! - A provider that already ran out during this ticket (`exclude`) is never started on again and
//!   never handed over to, whatever its reported figures say — a hard limit arrives long before the
//!   quota adapter shows one.
//! - A provider this ticket was already moved away from for being near its limit (`left_behind`) is
//!   never a hand-over target again for that ticket. Without this, two providers both near their
//!   limit hand the ticket back and forth on every check — one ticket once did so 109 times in three
//!   hours.
//! - A provider that reports nothing is *unknown*. Unknown is a last resort: it is preferred to
//!   stopping the ticket, but never to a provider with a known allowance below the threshold. It may
//!   always be the provider the run is already on, because refusing to start anything on a provider
//!   that simply does not report usage would make the schedule useless for it.

use std::collections::HashMap;

/// The share of a provider's allowance, 0-1, at which work moves elsewhere.
pub const DEFAULT_HANDOVER_THRESHOLD: f64 = 0.95;

/// Allowance a ticket is assumed to need while it runs, as a share of a provider's allowance.
/// Deliberately generous: it only decides whether an *extra* lane may start, and guessing low is how
/// an overnight run empties a plan.
pub const LANE_ALLOWANCE_RESERVE: f64 = 0.1;

/// Why a ticket cannot start on any provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PauseWhy {
    /// No provider is enabled and set up at all.
    NoProvider,
    /// Providers exist, but none of them has room.
    Budget,
}

/// What the budget decides for one ticket.
#[derive(Debug, Clone, PartialEq)]
pub enum ProviderDecision {
    /// Carry on with `provider`. `allowance_known` is false when its usage is not reported.
    Ok {
        provider: String,
        allowance_known: bool,
        used_fraction: Option<f64>,
        reason: String,
    },
    /// The active provider is at the threshold; move to `provider`.
    Handover {
        provider: String,
        from: Option<String>,
        used_fraction: Option<f64>,
        /// `None` when the target's allowance is known; `Some(false)` when it reports nothing.
        allowance_known: Option<bool>,
        reason: String,
    },
    /// Nothing safe to run on.
    Pause { reason: String, why: PauseWhy },
}

/// Allowance used per provider, as a 0-1 fraction. A provider that does not report its usage is
/// simply absent.
#[derive(Debug, Clone, Default)]
pub struct ProviderUsage {
    used: HashMap<String, f64>,
}

impl ProviderUsage {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn with(mut self, provider: impl Into<String>, used: f64) -> Self {
        self.used.insert(provider.into(), used);
        self
    }

    /// The allowance used, or `None` when the provider does not report it.
    #[must_use]
    pub fn get(&self, provider: &str) -> Option<f64> {
        self.used
            .get(provider)
            .copied()
            .filter(|value| value.is_finite())
    }

    /// Whether the provider reports a usable allowance figure.
    #[must_use]
    pub fn known(&self, provider: &str) -> bool {
        self.get(provider).is_some()
    }
}

/// The figures the decision is made from.
#[derive(Debug, Clone)]
pub struct ProviderBudgetInput<'a> {
    /// The provider the ticket is on, or would start on.
    pub active: Option<&'a str>,
    /// Providers that are enabled and set up, in preference order.
    pub usable: &'a [String],
    /// Allowance used per provider.
    pub used: &'a ProviderUsage,
    /// Providers that ran out during this ticket: never chosen, whatever their figures say.
    pub exclude: &'a [String],
    /// Providers this ticket was already handed over *from*. They may stay the one it is on, but are
    /// never a hand-over target again, whatever they report now.
    pub left_behind: &'a [String],
    /// When nothing else can run, an excluded provider may still be chosen rather than stopping the
    /// ticket. Used when starting work: a limit an hour ago may have cleared, and refusing to start
    /// anything at all is worse than trying.
    pub excluded_as_last_resort: bool,
    /// Overrides [`DEFAULT_HANDOVER_THRESHOLD`].
    pub threshold: Option<f64>,
}

/// The highest share used across a provider's allowance windows, or `None` when none is reported.
#[must_use]
pub fn provider_headroom(windows: &[Option<f64>]) -> Option<f64> {
    windows
        .iter()
        .filter_map(|value| value.filter(|v| v.is_finite()))
        .reduce(f64::max)
}

/// A percentage, the way the runtime that wrote the original phrased it.
fn percent(fraction: f64) -> String {
    format!("{}%", (fraction * 100.0).round())
}

/// Decides which provider a ticket runs on, and whether it moves.
#[must_use]
pub fn decide_provider_for_entry(input: &ProviderBudgetInput<'_>) -> ProviderDecision {
    let threshold = input.threshold.unwrap_or(DEFAULT_HANDOVER_THRESHOLD);
    let exclude = input.exclude;
    if input.usable.is_empty() {
        return ProviderDecision::Pause {
            reason: "No AI provider is enabled and set up to run the tickets.".into(),
            why: PauseWhy::NoProvider,
        };
    }
    // `current` is what the ticket is actually on; `active` is that provider when it is still an
    // option.
    let current = input
        .active
        .filter(|active| input.usable.iter().any(|p| p == active))
        .map(str::to_string);
    let spent = current
        .as_ref()
        .is_some_and(|current| exclude.iter().any(|p| p == current));
    // Anything already spent is out — unless there is nothing else to run on and the caller would
    // rather try again than stop the ticket (a limit an hour ago may have cleared).
    let open: Vec<&String> = input
        .usable
        .iter()
        .filter(|provider| !exclude.iter().any(|p| p == *provider))
        .collect();
    let retrying_spent = open.is_empty() && input.excluded_as_last_resort;
    let candidates: Vec<&String> = if retrying_spent {
        input.usable.iter().collect()
    } else {
        open
    };
    if candidates.is_empty() {
        return ProviderDecision::Pause {
            reason: format!(
                "Every provider that is set up ran out during this ticket ({}).",
                exclude.join(", ")
            ),
            why: PauseWhy::Budget,
        };
    }
    let active = current
        .as_ref()
        .filter(|current| candidates.contains(current))
        .cloned();
    if let Some(active) = &active {
        match input.used.get(active) {
            None => {
                return ProviderDecision::Ok {
                    provider: active.clone(),
                    allowance_known: false,
                    used_fraction: None,
                    reason: format!(
                        "{active} does not report its allowance, so it could not be checked."
                    ),
                };
            }
            Some(used) if used < threshold => {
                return ProviderDecision::Ok {
                    provider: active.clone(),
                    allowance_known: true,
                    used_fraction: Some(used),
                    reason: format!("{active} has used {} of its allowance.", percent(used)),
                };
            }
            Some(_) => {}
        }
    }

    let left_behind = input.left_behind;
    let others: Vec<&String> = candidates
        .iter()
        .copied()
        .filter(|provider| Some(*provider) != current.as_ref())
        .filter(|provider| !left_behind.iter().any(|p| p == *provider))
        .collect();
    // Known and below the threshold first, most room left first; a provider that reports nothing
    // only when nothing better is left, which beats stopping a ticket that could still run.
    let mut free: Vec<&&String> = others
        .iter()
        .filter(|provider| {
            input
                .used
                .get(provider)
                .is_some_and(|used| used < threshold)
        })
        .collect();
    free.sort_by(|left, right| {
        input
            .used
            .get(left)
            .unwrap_or(f64::NEG_INFINITY)
            .total_cmp(&input.used.get(right).unwrap_or(f64::NEG_INFINITY))
    });
    let unknown: Vec<&&String> = others
        .iter()
        .filter(|provider| !input.used.known(provider))
        .collect();
    let next = free.first().copied().or_else(|| unknown.first().copied());
    if let Some(next) = next {
        let next_used = input.used.get(next);
        let described = match next_used {
            Some(used) => format!("{} used", percent(used)),
            None => "allowance not reported".to_string(),
        };
        let used_current = current.as_ref().and_then(|current| input.used.get(current));
        let reason = match (&current, spent) {
            (None, _) => format!("Starting on {next} ({described})."),
            (Some(current), true) => format!("{current} ran out; moving to {next} ({described})."),
            (Some(current), false) => format!(
                "{current} has used {} of its allowance; moving to {next} ({described}).",
                percent(used_current.unwrap_or_default())
            ),
        };
        return ProviderDecision::Handover {
            provider: (*next).clone(),
            from: current.clone(),
            used_fraction: used_current,
            allowance_known: if free.is_empty() { Some(false) } else { None },
            reason,
        };
    }
    let reason = match (&current, spent) {
        (None, _) => format!("No provider has an allowance below {}.", percent(threshold)),
        (Some(current), true) => {
            format!("{current} ran out and no other provider is available to move the ticket to.")
        }
        (Some(current), false) => {
            let left_behind_others: Vec<&String> = candidates
                .iter()
                .copied()
                .filter(|provider| Some(provider.as_str()) != Some(current.as_str()))
                .filter(|provider| left_behind.iter().any(|p| p == *provider))
                .collect();
            let used = input.used.get(current.as_str()).unwrap_or_default();
            if !left_behind_others.is_empty() {
                format!(
                    "{current} has used {} of its allowance, and this ticket already moved away from {} for the same reason.",
                    percent(used),
                    left_behind_others
                        .iter()
                        .map(|p| p.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            } else {
                format!(
                    "{current} has used {} of its allowance and every other provider is at or past {}.",
                    percent(used),
                    percent(threshold)
                )
            }
        }
    };
    ProviderDecision::Pause {
        reason,
        why: PauseWhy::Budget,
    }
}

/// The figures the extra-lane decision is made from.
#[derive(Debug, Clone)]
pub struct ExtraLaneInput<'a> {
    /// The provider the extra ticket would start on.
    pub provider: &'a str,
    /// That provider's allowance used, 0-1; `None` when it does not report.
    pub used: Option<f64>,
    /// Tickets already running on that provider in this run.
    pub alongside: usize,
    /// Overrides [`DEFAULT_HANDOVER_THRESHOLD`].
    pub threshold: Option<f64>,
}

/// Whether one more ticket may start while others are running. The first ticket of a run never
/// asks: this is only for a second lane and beyond. Unknown usage refuses, because the run cannot
/// tell whether there is room for two.
#[must_use]
pub fn decide_extra_lane(input: &ExtraLaneInput<'_>) -> (bool, String) {
    let threshold = input.threshold.unwrap_or(DEFAULT_HANDOVER_THRESHOLD);
    let tickets = input.alongside + 1;
    let Some(used) = input.used.filter(|value| value.is_finite()) else {
        return (
            false,
            format!(
                "{} does not report its allowance, so no extra ticket starts alongside the ones running.",
                input.provider
            ),
        );
    };
    let room = threshold - used;
    let needed = tickets as f64 * LANE_ALLOWANCE_RESERVE;
    let head = format!(
        "{} has used {}, leaving {} before the {} hand-over point",
        input.provider,
        percent(used),
        percent(room.max(0.0)),
        percent(threshold)
    );
    if room + 1e-9 >= needed {
        (
            true,
            format!(
                "{head}: room for {tickets} ticket{} at {} each.",
                if tickets == 1 { "" } else { "s" },
                percent(LANE_ALLOWANCE_RESERVE)
            ),
        )
    } else {
        (
            false,
            format!(
                "{head}: not enough for {tickets} tickets at {} each, so the next one waits.",
                percent(LANE_ALLOWANCE_RESERVE)
            ),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(pairs: &[(&str, f64)]) -> ProviderUsage {
        let mut usage = ProviderUsage::new();
        for (provider, used) in pairs {
            usage = usage.with(*provider, *used);
        }
        usage
    }

    fn decide(
        active: Option<&str>,
        usable: &[&str],
        used: &ProviderUsage,
        exclude: &[&str],
        left_behind: &[&str],
        excluded_as_last_resort: bool,
    ) -> ProviderDecision {
        let usable: Vec<String> = usable.iter().map(|s| (*s).to_string()).collect();
        let exclude: Vec<String> = exclude.iter().map(|s| (*s).to_string()).collect();
        let left_behind: Vec<String> = left_behind.iter().map(|s| (*s).to_string()).collect();
        decide_provider_for_entry(&ProviderBudgetInput {
            active,
            usable: &usable,
            used,
            exclude: &exclude,
            left_behind: &left_behind,
            excluded_as_last_resort,
            threshold: None,
        })
    }

    #[test]
    fn headroom_is_the_highest_window_and_unknown_when_nothing_is_reported() {
        assert_eq!(provider_headroom(&[Some(0.2), Some(0.7), None]), Some(0.7));
        assert_eq!(provider_headroom(&[None]), None);
        assert_eq!(provider_headroom(&[]), None);
    }

    #[test]
    fn a_known_provider_under_the_threshold_carries_on() {
        let used = usage(&[("claude", 0.5), ("codex", 0.1)]);
        let decision = decide(Some("claude"), &["claude", "codex"], &used, &[], &[], false);
        assert_eq!(
            decision,
            ProviderDecision::Ok {
                provider: "claude".into(),
                allowance_known: true,
                used_fraction: Some(0.5),
                reason: "claude has used 50% of its allowance.".into(),
            }
        );
    }

    #[test]
    fn exactly_ninety_five_percent_hands_over_and_just_under_does_not() {
        let used = usage(&[("claude", 0.949), ("codex", 0.1)]);
        assert!(matches!(
            decide(Some("claude"), &["claude", "codex"], &used, &[], &[], false),
            ProviderDecision::Ok { .. }
        ));
        let used = usage(&[("claude", 0.95), ("codex", 0.1)]);
        let decision = decide(Some("claude"), &["claude", "codex"], &used, &[], &[], false);
        match decision {
            ProviderDecision::Handover { provider, .. } => assert_eq!(provider, "codex"),
            other => panic!("expected a handover, got {other:?}"),
        }
    }

    #[test]
    fn hand_over_prefers_the_provider_with_the_most_room() {
        let used = usage(&[("a", 0.99), ("b", 0.6), ("c", 0.2)]);
        let decision = decide(Some("a"), &["a", "b", "c"], &used, &[], &[], false);
        match decision {
            ProviderDecision::Handover { provider, .. } => assert_eq!(provider, "c"),
            other => panic!("expected a handover, got {other:?}"),
        }
    }

    #[test]
    fn a_known_provider_under_the_threshold_beats_one_that_reports_nothing() {
        let used = usage(&[("a", 0.97), ("c", 0.5)]);
        let decision = decide(Some("a"), &["a", "b", "c"], &used, &[], &[], false);
        match decision {
            ProviderDecision::Handover { provider, .. } => assert_eq!(provider, "c"),
            other => panic!("expected a handover, got {other:?}"),
        }
    }

    #[test]
    fn a_provider_that_reports_nothing_is_a_last_resort_rather_than_a_stop() {
        let used = usage(&[("claude", 0.97)]);
        let decision = decide(
            Some("claude"),
            &["claude", "copilot"],
            &used,
            &[],
            &[],
            false,
        );
        match decision {
            ProviderDecision::Handover {
                provider,
                allowance_known,
                ..
            } => {
                assert_eq!(provider, "copilot");
                assert_eq!(allowance_known, Some(false));
            }
            other => panic!("expected a handover, got {other:?}"),
        }
    }

    #[test]
    fn when_every_known_provider_is_spent_the_ticket_pauses() {
        let used = usage(&[("a", 0.97), ("b", 0.99)]);
        let decision = decide(Some("a"), &["a", "b"], &used, &[], &[], false);
        assert_eq!(
            decision,
            ProviderDecision::Pause {
                reason:
                    "a has used 97% of its allowance and every other provider is at or past 95%."
                        .into(),
                why: PauseWhy::Budget,
            }
        );
    }

    #[test]
    fn a_provider_that_ran_out_is_never_chosen_again_whatever_it_reports_now() {
        let used = usage(&[("a", 0.1), ("b", 0.2), ("c", 0.3)]);
        let decision = decide(Some("a"), &["a", "b", "c"], &used, &["a"], &[], false);
        match decision {
            ProviderDecision::Handover { provider, .. } => assert_eq!(provider, "b"),
            other => panic!("expected a handover, got {other:?}"),
        }
        let used = usage(&[("a", 0.1), ("b", 0.2)]);
        let decision = decide(Some("a"), &["a", "b"], &used, &["a", "b"], &[], false);
        assert!(matches!(
            decision,
            ProviderDecision::Pause {
                why: PauseWhy::Budget,
                ..
            }
        ));
    }

    #[test]
    fn an_excluded_active_provider_with_an_unknown_allowance_is_still_replaced() {
        let used = usage(&[("b", 0.4)]);
        let decision = decide(Some("a"), &["a", "b"], &used, &["a"], &[], false);
        match decision {
            ProviderDecision::Handover { provider, .. } => assert_eq!(provider, "b"),
            other => panic!("expected a handover, got {other:?}"),
        }
    }

    #[test]
    fn starting_work_falls_back_to_an_excluded_provider_rather_than_stopping() {
        let used = usage(&[("a", 0.1)]);
        let start = decide(Some("a"), &["a"], &used, &["a"], &[], true);
        assert!(matches!(
            start,
            ProviderDecision::Ok {
                provider,
                ..
            } if provider == "a"
        ));
        let mid_ticket = decide(Some("a"), &["a"], &used, &["a"], &[], false);
        assert!(matches!(mid_ticket, ProviderDecision::Pause { .. }));
    }

    #[test]
    fn an_active_provider_that_reports_nothing_still_runs_flagged_as_unchecked() {
        let used = usage(&[("codex", 0.1)]);
        let decision = decide(
            Some("copilot"),
            &["copilot", "codex"],
            &used,
            &[],
            &[],
            false,
        );
        match decision {
            ProviderDecision::Ok {
                provider,
                allowance_known,
                ..
            } => {
                assert_eq!(provider, "copilot");
                assert!(!allowance_known);
            }
            other => panic!("expected an ok, got {other:?}"),
        }
    }

    #[test]
    fn with_no_active_provider_the_best_known_one_starts() {
        let used = usage(&[("a", 0.8), ("b", 0.3)]);
        let decision = decide(None, &["a", "b"], &used, &[], &[], false);
        match decision {
            ProviderDecision::Handover { provider, from, .. } => {
                assert_eq!(provider, "b");
                assert_eq!(from, None);
            }
            other => panic!("expected a handover, got {other:?}"),
        }
    }

    #[test]
    fn no_usable_provider_pauses_for_no_provider() {
        let used = ProviderUsage::new();
        let decision = decide(Some("claude"), &[], &used, &[], &[], false);
        assert_eq!(
            decision,
            ProviderDecision::Pause {
                reason: "No AI provider is enabled and set up to run the tickets.".into(),
                why: PauseWhy::NoProvider,
            }
        );
    }

    #[test]
    fn an_active_provider_that_is_not_usable_is_replaced() {
        let used = usage(&[("codex", 0.2)]);
        let decision = decide(Some("gone"), &["codex"], &used, &[], &[], false);
        match decision {
            ProviderDecision::Handover { provider, from, .. } => {
                assert_eq!(provider, "codex");
                assert_eq!(from, None);
            }
            other => panic!("expected a handover, got {other:?}"),
        }
    }

    #[test]
    fn a_provider_the_ticket_was_moved_away_from_is_never_a_hand_over_target_again() {
        // The shape that bounced one ticket 109 times: both near the limit, each reading a little
        // lower in turn.
        let used = usage(&[("claude", 0.5), ("codex", 0.98)]);
        let decision = decide(
            Some("codex"),
            &["claude", "codex"],
            &used,
            &[],
            &["claude"],
            false,
        );
        match &decision {
            ProviderDecision::Pause { reason, .. } => {
                assert!(
                    reason.contains("already moved away from claude"),
                    "{reason}"
                );
            }
            other => panic!("expected a pause, got {other:?}"),
        }
        // Another provider with room is still fine.
        let used = usage(&[("claude", 0.5), ("codex", 0.98), ("copilot", 0.4)]);
        let decision = decide(
            Some("codex"),
            &["claude", "codex", "copilot"],
            &used,
            &[],
            &["claude"],
            false,
        );
        match decision {
            ProviderDecision::Handover { provider, from, .. } => {
                assert_eq!(from.as_deref(), Some("codex"));
                assert_eq!(provider, "copilot");
            }
            other => panic!("expected a handover, got {other:?}"),
        }
        // Left behind does not stop it carrying on where it is, when it has room there.
        let used = usage(&[("claude", 0.5), ("codex", 0.2)]);
        let decision = decide(
            Some("claude"),
            &["claude", "codex"],
            &used,
            &[],
            &["claude"],
            false,
        );
        assert!(matches!(decision, ProviderDecision::Ok { .. }));
    }

    #[test]
    fn an_extra_lane_needs_room_for_every_ticket_on_the_provider() {
        let (ok, reason) = decide_extra_lane(&ExtraLaneInput {
            provider: "claude",
            used: Some(0.5),
            alongside: 0,
            threshold: None,
        });
        assert!(ok, "{reason}");
        assert!(reason.contains("room for 1 ticket at 10% each"), "{reason}");

        let (ok, reason) = decide_extra_lane(&ExtraLaneInput {
            provider: "claude",
            used: Some(0.94),
            alongside: 0,
            threshold: None,
        });
        assert!(!ok, "{reason}");
        assert!(reason.contains("not enough for 1 ticket"), "{reason}");
    }

    #[test]
    fn an_extra_lane_refuses_when_the_provider_reports_nothing() {
        let (ok, reason) = decide_extra_lane(&ExtraLaneInput {
            provider: "claude",
            used: None,
            alongside: 1,
            threshold: None,
        });
        assert!(!ok);
        assert!(reason.contains("does not report its allowance"), "{reason}");
    }
}
