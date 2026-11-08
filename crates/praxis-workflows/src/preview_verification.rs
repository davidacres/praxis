//! Preview verification (`projects/previewVerification.ts` port).
//!
//! A repeatable check against a Run preview: scripted interactions, then deterministic
//! assertions over what was observed. `passed` is computed only from the assertion results.
//! A screenshot is evidence for a person and never decides the outcome. Screenshot
//! comparison is byte identity, not a similarity score.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum PreviewInteraction {
    /// `selector` is a stable CSS selector, unlike an ephemeral snapshot ref.
    Click {
        selector: String,
    },
    #[serde(rename_all = "camelCase")]
    Type {
        selector: String,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        submit: Option<bool>,
    },
    Wait {
        ms: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum PreviewAssertion {
    TextPresent {
        text: String,
    },
    TextAbsent {
        text: String,
    },
    NoConsoleErrors,
    NoFailedRequests,
    #[serde(rename_all = "camelCase")]
    HttpStatus {
        url_contains: String,
        expected_status: u16,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewVerificationCheck {
    pub id: String,
    pub name: String,
    pub service_id: String,
    /// Relative to the service's preview origin, e.g. `/checkout`.
    pub path: String,
    pub interactions: Vec<PreviewInteraction>,
    pub assertions: Vec<PreviewAssertion>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConsoleLevel {
    Log,
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConsoleEntry {
    pub level: ConsoleLevel,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NetworkEntry {
    pub url: String,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// What a verification run observed: page text plus the console and network capture.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewVerificationSnapshot {
    pub page_text: String,
    pub console: Vec<ConsoleEntry>,
    pub network: Vec<NetworkEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssertionResult {
    pub assertion: PreviewAssertion,
    pub passed: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BaselineComparison {
    Match,
    Differs,
    NoBaseline,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotEvidence {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline_comparison: Option<BaselineComparison>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewVerificationOutcome {
    pub check_id: String,
    pub service_id: String,
    /// Computed only from `results`.
    pub passed: bool,
    pub results: Vec<AssertionResult>,
    pub captured_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screenshot: Option<ScreenshotEvidence>,
}

fn describe_assertion(assertion: &PreviewAssertion) -> String {
    match assertion {
        PreviewAssertion::TextPresent { text } => format!("text present: \"{text}\""),
        PreviewAssertion::TextAbsent { text } => format!("text absent: \"{text}\""),
        PreviewAssertion::NoConsoleErrors => "no console errors".to_string(),
        PreviewAssertion::NoFailedRequests => "no failed requests".to_string(),
        PreviewAssertion::HttpStatus {
            url_contains,
            expected_status,
        } => format!("{url_contains} → HTTP {expected_status}"),
    }
}

fn evaluate_one(
    assertion: &PreviewAssertion,
    snapshot: &PreviewVerificationSnapshot,
) -> AssertionResult {
    let (passed, detail) = match assertion {
        PreviewAssertion::TextPresent { text } => {
            let found = snapshot.page_text.contains(text.as_str());
            (
                found,
                if found {
                    format!("Found \"{text}\".")
                } else {
                    format!("Expected to find \"{text}\" on the page.")
                },
            )
        }
        PreviewAssertion::TextAbsent { text } => {
            let found = snapshot.page_text.contains(text.as_str());
            (
                !found,
                if found {
                    format!("Found \"{text}\", which should not appear.")
                } else {
                    format!("\"{text}\" correctly absent.")
                },
            )
        }
        PreviewAssertion::NoConsoleErrors => {
            let messages: Vec<&str> = snapshot
                .console
                .iter()
                .filter(|entry| entry.level == ConsoleLevel::Error)
                .map(|entry| entry.message.as_str())
                .collect();
            (
                messages.is_empty(),
                if messages.is_empty() {
                    "No console errors.".to_string()
                } else {
                    format!(
                        "{} console error(s): {}",
                        messages.len(),
                        messages.join("; ")
                    )
                },
            )
        }
        PreviewAssertion::NoFailedRequests => {
            let failures: Vec<String> = snapshot
                .network
                .iter()
                .map(|n| format!("{} {} ({})", n.method, n.url, describe_network_outcome(n)))
                .collect();
            (
                failures.is_empty(),
                if failures.is_empty() {
                    "No failed requests.".to_string()
                } else {
                    format!(
                        "{} failed request(s): {}",
                        failures.len(),
                        failures.join("; ")
                    )
                },
            )
        }
        PreviewAssertion::HttpStatus {
            url_contains,
            expected_status,
        } => {
            // Only failures are captured. A request with no captured failure is assumed to
            // have succeeded, so the common "this should succeed" shape passes.
            match snapshot
                .network
                .iter()
                .find(|entry| entry.url.contains(url_contains.as_str()))
            {
                None => (
                    true,
                    format!(
                        "No failed request matching \"{url_contains}\" — assumed to have succeeded."
                    ),
                ),
                Some(matching) => {
                    let passed = matching.status == Some(*expected_status);
                    let detail = if passed {
                        format!("{url_contains} returned {expected_status} as expected.")
                    } else {
                        format!(
                            "{url_contains} returned {}, expected {expected_status}.",
                            matching
                                .status
                                .map(|s| s.to_string())
                                .or_else(|| matching.error.clone())
                                .unwrap_or_else(|| "no response".to_string())
                        )
                    };
                    (passed, detail)
                }
            }
        }
    };
    AssertionResult {
        assertion: assertion.clone(),
        passed,
        detail,
    }
}

fn describe_network_outcome(entry: &NetworkEntry) -> String {
    match (entry.status, &entry.error) {
        (Some(status), _) => status.to_string(),
        (None, Some(error)) => error.clone(),
        (None, None) => "failed".to_string(),
    }
}

#[must_use]
pub fn evaluate_assertions(
    assertions: &[PreviewAssertion],
    snapshot: &PreviewVerificationSnapshot,
) -> Vec<AssertionResult> {
    assertions
        .iter()
        .map(|assertion| evaluate_one(assertion, snapshot))
        .collect()
}

/// Builds an outcome. It passes only when every assertion passed. With no assertions it passes
/// vacuously, so a check made only of interactions is not a failure.
#[must_use]
pub fn summarize_outcome(
    check_id: &str,
    service_id: &str,
    results: Vec<AssertionResult>,
    captured_at: &str,
    screenshot: Option<ScreenshotEvidence>,
) -> PreviewVerificationOutcome {
    PreviewVerificationOutcome {
        check_id: check_id.to_string(),
        service_id: service_id.to_string(),
        passed: results.iter().all(|result| result.passed),
        results,
        captured_at: captured_at.to_string(),
        screenshot,
    }
}

/// Byte identity only: same bytes in, same bytes out. Never used to decide `passed`.
#[must_use]
pub fn screenshots_match(a: &[u8], b: &[u8]) -> bool {
    a == b
}

/// Renders a failed outcome as evidence text, for a diagnosis agent to read as data.
#[must_use]
pub fn render_verification_failure_context(
    check: &PreviewVerificationCheck,
    outcome: &PreviewVerificationOutcome,
) -> String {
    if outcome.passed {
        return format!(
            "Preview verification \"{}\" passed — no failure context to report.",
            check.name
        );
    }
    let failed: Vec<&AssertionResult> = outcome.results.iter().filter(|r| !r.passed).collect();
    let mut lines = vec![
        format!(
            "Preview verification \"{}\" failed (service: {}, path: {}).",
            check.name, check.service_id, check.path
        ),
        String::new(),
        format!(
            "{} of {} assertion(s) failed:",
            failed.len(),
            outcome.results.len()
        ),
    ];
    lines.extend(
        failed
            .iter()
            .map(|r| format!("- {}: {}", describe_assertion(&r.assertion), r.detail)),
    );
    lines.push(String::new());
    if let Some(screenshot) = &outcome.screenshot {
        lines.push(match screenshot.baseline_comparison {
            Some(BaselineComparison::Differs) => {
                "A screenshot was captured and differs from the stored baseline (byte comparison only — open both images to see how).".to_string()
            }
            _ => format!("A screenshot was captured at {}.", screenshot.path),
        });
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> PreviewVerificationSnapshot {
        PreviewVerificationSnapshot {
            page_text: "Welcome to checkout".into(),
            console: vec![ConsoleEntry {
                level: ConsoleLevel::Warning,
                message: "deprecated".into(),
            }],
            network: vec![],
        }
    }

    fn single(
        assertion: PreviewAssertion,
        snapshot: &PreviewVerificationSnapshot,
    ) -> AssertionResult {
        evaluate_assertions(&[assertion], snapshot).remove(0)
    }

    #[test]
    fn text_present_passes_when_the_text_is_on_the_page_and_fails_otherwise() {
        let s = snapshot();
        assert!(
            single(
                PreviewAssertion::TextPresent {
                    text: "checkout".into()
                },
                &s
            )
            .passed
        );
        assert!(
            !single(
                PreviewAssertion::TextPresent {
                    text: "cart".into()
                },
                &s
            )
            .passed
        );
    }

    #[test]
    fn text_absent_is_the_inverse_of_text_present() {
        let s = snapshot();
        assert!(
            single(
                PreviewAssertion::TextAbsent {
                    text: "cart".into()
                },
                &s
            )
            .passed
        );
        assert!(
            !single(
                PreviewAssertion::TextAbsent {
                    text: "checkout".into()
                },
                &s
            )
            .passed
        );
    }

    #[test]
    fn no_console_errors_ignores_warnings_and_fails_on_an_error() {
        let mut s = snapshot();
        assert!(single(PreviewAssertion::NoConsoleErrors, &s).passed);
        s.console.push(ConsoleEntry {
            level: ConsoleLevel::Error,
            message: "boom".into(),
        });
        let result = single(PreviewAssertion::NoConsoleErrors, &s);
        assert!(!result.passed);
        assert!(result.detail.contains("boom"));
    }

    #[test]
    fn no_failed_requests_passes_on_an_empty_network_list_only() {
        let mut s = snapshot();
        assert!(single(PreviewAssertion::NoFailedRequests, &s).passed);
        s.network.push(NetworkEntry {
            url: "http://x/api".into(),
            method: "GET".into(),
            status: Some(500),
            error: None,
        });
        let result = single(PreviewAssertion::NoFailedRequests, &s);
        assert!(!result.passed);
        assert!(result.detail.contains("GET http://x/api (500)"));
    }

    #[test]
    fn http_status_passes_when_no_failure_was_captured_for_that_request() {
        let assertion = PreviewAssertion::HttpStatus {
            url_contains: "/api/cart".into(),
            expected_status: 200,
        };
        assert!(single(assertion, &snapshot()).passed);
    }

    #[test]
    fn http_status_fails_only_on_a_captured_failure_with_the_wrong_status() {
        let mut s = snapshot();
        s.network.push(NetworkEntry {
            url: "http://x/api/cart".into(),
            method: "GET".into(),
            status: Some(503),
            error: None,
        });
        let wrong = single(
            PreviewAssertion::HttpStatus {
                url_contains: "/api/cart".into(),
                expected_status: 200,
            },
            &s,
        );
        assert!(!wrong.passed);
        let right = single(
            PreviewAssertion::HttpStatus {
                url_contains: "/api/cart".into(),
                expected_status: 503,
            },
            &s,
        );
        assert!(right.passed);
    }

    #[test]
    fn an_outcome_passes_only_when_every_assertion_passed() {
        let s = snapshot();
        let results = evaluate_assertions(
            &[
                PreviewAssertion::TextPresent {
                    text: "checkout".into(),
                },
                PreviewAssertion::TextPresent {
                    text: "cart".into(),
                },
            ],
            &s,
        );
        let outcome = summarize_outcome("c", "web", results, "t", None);
        assert!(!outcome.passed);
    }

    #[test]
    fn an_outcome_with_zero_assertions_passes_vacuously() {
        let outcome = summarize_outcome("c", "web", vec![], "t", None);
        assert!(outcome.passed);
    }

    #[test]
    fn a_screenshot_that_differs_never_flips_passed_on_its_own() {
        let results = evaluate_assertions(&[PreviewAssertion::NoConsoleErrors], &snapshot());
        let outcome = summarize_outcome(
            "c",
            "web",
            results,
            "t",
            Some(ScreenshotEvidence {
                path: "shot.png".into(),
                baseline_comparison: Some(BaselineComparison::Differs),
            }),
        );
        assert!(outcome.passed);
    }

    #[test]
    fn screenshots_match_is_byte_identity_and_never_panics_on_different_lengths() {
        assert!(screenshots_match(b"abc", b"abc"));
        assert!(!screenshots_match(b"abc", b"abd"));
        assert!(!screenshots_match(b"abc", b"abcd"));
    }

    #[test]
    fn failure_context_lists_only_failed_assertions_with_their_own_detail() {
        let check = PreviewVerificationCheck {
            id: "c".into(),
            name: "Checkout".into(),
            service_id: "web".into(),
            path: "/checkout".into(),
            interactions: vec![PreviewInteraction::Wait { ms: 10 }],
            assertions: vec![],
        };
        let results = evaluate_assertions(
            &[
                PreviewAssertion::TextPresent {
                    text: "checkout".into(),
                },
                PreviewAssertion::TextPresent {
                    text: "cart".into(),
                },
            ],
            &snapshot(),
        );
        let outcome = summarize_outcome("c", "web", results, "t", None);
        let text = render_verification_failure_context(&check, &outcome);
        assert!(text.contains("1 of 2 assertion(s) failed"));
        assert!(text.contains("- text present: \"cart\": Expected to find \"cart\""));
        assert!(!text.contains("text present: \"checkout\""));
    }

    #[test]
    fn failure_context_reports_a_pass_plainly() {
        let check = PreviewVerificationCheck {
            id: "c".into(),
            name: "Checkout".into(),
            service_id: "web".into(),
            path: "/".into(),
            interactions: vec![],
            assertions: vec![],
        };
        let outcome = summarize_outcome("c", "web", vec![], "t", None);
        assert!(render_verification_failure_context(&check, &outcome).contains("passed"));
    }
}
