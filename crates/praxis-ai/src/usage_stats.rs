//! The usage ledger: what each AI turn cost, aggregated per model and session.

#[cfg(test)]
mod tests {
    use super::{
        AiUsageEvent, AiUsageTokens, daily_usage, summarize_usage, summarize_usage_by_model,
        usage_trend,
    };
    use chrono::{DateTime, Utc};

    fn event(
        id: &str,
        at: &str,
        provider: &str,
        model: &str,
        input: u64,
        output: u64,
        cost_usd: f64,
    ) -> AiUsageEvent {
        AiUsageEvent {
            id: id.to_string(),
            at: at.to_string(),
            provider: provider.to_string(),
            model: model.to_string(),
            session_id: None,
            tokens: AiUsageTokens {
                input,
                output,
                cached: None,
                reasoning: None,
            },
            cost_usd: Some(cost_usd),
        }
    }

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-02-10T12:00:00Z")
            .expect("the timestamp is valid")
            .with_timezone(&Utc)
    }

    #[test]
    fn requests_tokens_and_cost_are_summarised() {
        let totals = summarize_usage(&[
            event(
                "a",
                "2026-02-09T10:00:00Z",
                "openai",
                "gpt-4o",
                1000,
                500,
                0.1,
            ),
            event(
                "b",
                "2026-02-09T11:00:00Z",
                "openai",
                "gpt-4o",
                2000,
                1000,
                0.15,
            ),
        ]);
        assert_eq!(totals.requests, 2);
        assert_eq!(totals.input_tokens, 3000);
        assert_eq!(totals.output_tokens, 1500);
        assert_eq!(totals.total_tokens(), 4500);
        assert!((totals.cost_usd - 0.25).abs() < 1e-9);
    }

    #[test]
    fn usage_is_summarised_per_provider_and_model() {
        let by_model = summarize_usage_by_model(&[
            event(
                "a",
                "2026-02-09T10:00:00Z",
                "openai",
                "gpt-4o",
                1000,
                500,
                0.1,
            ),
            event(
                "b",
                "2026-02-09T11:00:00Z",
                "openai",
                "gpt-4o",
                2000,
                1000,
                0.15,
            ),
            event(
                "c",
                "2026-02-10T09:00:00Z",
                "anthropic",
                "claude-sonnet-4-5",
                500,
                250,
                0.2,
            ),
        ]);
        assert_eq!(by_model.len(), 2);
        let openai = by_model
            .get("openai::gpt-4o")
            .expect("the openai model is present");
        assert_eq!(openai.requests, 2);
        assert_eq!(openai.input_tokens, 3000);
        assert_eq!(openai.output_tokens, 1500);
        let anthropic = by_model
            .get("anthropic::claude-sonnet-4-5")
            .expect("the anthropic model is present");
        assert_eq!(anthropic.requests, 1);
        assert_eq!(anthropic.input_tokens, 500);
    }

    #[test]
    fn the_same_model_name_under_two_providers_stays_apart() {
        let by_model = summarize_usage_by_model(&[
            event(
                "a",
                "2026-02-09T10:00:00Z",
                "openai",
                "gpt-4o",
                100,
                50,
                0.0,
            ),
            event(
                "b",
                "2026-02-09T11:00:00Z",
                "azure",
                "gpt-4o",
                200,
                100,
                0.0,
            ),
        ]);
        assert_eq!(by_model.len(), 2);
        assert!(by_model.contains_key("openai::gpt-4o"));
        assert!(by_model.contains_key("azure::gpt-4o"));
    }

    #[test]
    fn the_trend_buckets_requests_by_day() {
        let trend = usage_trend(
            &[
                event(
                    "a",
                    "2026-02-08T10:00:00Z",
                    "openai",
                    "gpt-4o",
                    100,
                    50,
                    0.0,
                ),
                event(
                    "b",
                    "2026-02-09T10:00:00Z",
                    "openai",
                    "gpt-4o",
                    200,
                    100,
                    0.0,
                ),
                event(
                    "c",
                    "2026-02-10T09:00:00Z",
                    "openai",
                    "gpt-4o",
                    300,
                    150,
                    0.0,
                ),
            ],
            3,
            now(),
        );
        assert_eq!(trend.len(), 3);
        assert_eq!(trend[0].day, "2026-02-08");
        assert_eq!(trend[0].requests, 1);
        assert_eq!(trend[1].day, "2026-02-09");
        assert_eq!(trend[1].requests, 1);
        assert_eq!(trend[1].input_tokens, 200);
        assert_eq!(trend[2].day, "2026-02-10");
        assert_eq!(trend[2].requests, 1);
        assert_eq!(trend[2].output_tokens, 150);
    }

    #[test]
    fn a_request_outside_the_window_is_left_out() {
        let trend = usage_trend(
            &[
                event(
                    "old",
                    "2026-01-01T10:00:00Z",
                    "openai",
                    "gpt-4o",
                    100,
                    50,
                    0.0,
                ),
                event(
                    "today",
                    "2026-02-10T09:00:00Z",
                    "openai",
                    "gpt-4o",
                    100,
                    50,
                    0.0,
                ),
            ],
            3,
            now(),
        );
        let total: u64 = trend.iter().map(|point| point.requests).sum();
        assert_eq!(total, 1);
    }

    #[test]
    fn the_daily_usage_totals_requests_tokens_and_cost_per_day() {
        let usage = daily_usage(
            &[
                event(
                    "a",
                    "2026-02-09T10:00:00Z",
                    "openai",
                    "gpt-4o",
                    1000,
                    500,
                    0.1,
                ),
                event(
                    "b",
                    "2026-02-09T11:00:00Z",
                    "openai",
                    "gpt-4o",
                    2000,
                    1000,
                    0.15,
                ),
                event(
                    "c",
                    "2026-02-10T09:00:00Z",
                    "anthropic",
                    "claude-sonnet-4-5",
                    500,
                    250,
                    0.1,
                ),
            ],
            3,
            now(),
        );
        let days: Vec<&str> = usage.iter().map(|point| point.day.as_str()).collect();
        assert_eq!(days, ["2026-02-08", "2026-02-09", "2026-02-10"]);
        assert_eq!(usage[0].requests, 0);
        assert_eq!(usage[1].requests, 2);
        assert_eq!(usage[1].input_tokens, 3000);
        assert_eq!(usage[1].output_tokens, 1500);
        assert!((usage[1].cost_usd - 0.25).abs() < 1e-9);
        assert_eq!(usage[2].requests, 1);
        assert_eq!(usage[2].input_tokens, 500);
        assert!((usage[2].cost_usd - 0.1).abs() < 1e-9);
    }
}
