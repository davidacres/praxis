//! Which model a stage's session should use (`stageModel.ts` port).
//!
//! Precedence, most specific first: the stage's exact `model`; the model mapped to the
//! stage's tier for the active provider; the run's model; the provider's default. Each
//! spent attempt escalates one tier, capped at the strongest.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::types::{WORKFLOW_MODEL_TIERS, WorkflowModelTier};

/// provider id → tier → model id.
pub type ModelTierMap = BTreeMap<String, BTreeMap<WorkflowModelTier, String>>;

/// The model chosen for a stage and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StageModelChoice {
    /// `None` means "use the provider's default".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tier: Option<WorkflowModelTier>,
    pub reason: String,
}

/// The model fields of an agent stage that drive the choice.
#[derive(Debug, Clone, Copy, Default)]
pub struct StageModelNode<'a> {
    pub model: Option<&'a str>,
    pub model_tier: Option<WorkflowModelTier>,
    pub escalate_on_retry: Option<bool>,
}

/// A model id a stage or run may carry, or `None` when it names no model. `default`
/// (a CLI agent's own default) means "the provider's default", not a model id.
#[must_use]
pub fn named_model(value: Option<&str>) -> Option<String> {
    let model = value?.trim();
    (!model.is_empty() && !model.eq_ignore_ascii_case("default")).then(|| model.to_string())
}

/// Parses a tier name.
#[must_use]
pub fn parse_model_tier(value: &str) -> Option<WorkflowModelTier> {
    WORKFLOW_MODEL_TIERS
        .into_iter()
        .find(|tier| tier.as_str() == value)
}

/// The tier `steps` above `tier`, capped at the strongest.
#[must_use]
pub fn escalate_tier(tier: WorkflowModelTier, steps: u32) -> WorkflowModelTier {
    let index = WORKFLOW_MODEL_TIERS
        .iter()
        .position(|candidate| *candidate == tier)
        .unwrap_or(0);
    let target = index
        .saturating_add(steps as usize)
        .min(WORKFLOW_MODEL_TIERS.len() - 1);
    WORKFLOW_MODEL_TIERS[target]
}

fn mapped_model(
    tiers: Option<&ModelTierMap>,
    provider: &str,
    tier: WorkflowModelTier,
) -> Option<String> {
    let model = tiers?.get(provider)?.get(&tier)?.trim();
    (!model.is_empty()).then(|| model.to_string())
}

/// Chooses a stage's model. `attempts_spent` counts attempts that spent the stage so far.
#[must_use]
pub fn choose_stage_model(
    node: StageModelNode<'_>,
    provider: &str,
    tiers: Option<&ModelTierMap>,
    run_model: Option<&str>,
    attempts_spent: u32,
) -> StageModelChoice {
    let run_model = named_model(run_model);

    if let Some(exact) = named_model(node.model) {
        return StageModelChoice {
            model: Some(exact),
            tier: None,
            reason: "the stage names this model".to_string(),
        };
    }

    if let Some(base_tier) = node.model_tier {
        let escalate = node.escalate_on_retry != Some(false);
        let tier = if escalate {
            escalate_tier(base_tier, attempts_spent)
        } else {
            base_tier
        };
        if let Some(mapped) = mapped_model(tiers, provider, tier) {
            let reason = if tier == base_tier {
                format!("{tier} tier")
            } else {
                let plural = if attempts_spent == 1 { "" } else { "s" };
                format!(
                    "{tier} tier (raised from {base_tier} after {attempts_spent} failed attempt{plural})"
                )
            };
            return StageModelChoice {
                model: Some(mapped),
                tier: Some(tier),
                reason,
            };
        }
        // An unmapped tier is not an error: the run's model still works.
        return StageModelChoice {
            model: run_model,
            tier: Some(tier),
            reason: format!(
                "no model is mapped to the {tier} tier for {provider}, so the run's model is used"
            ),
        };
    }

    match run_model {
        Some(model) => StageModelChoice {
            model: Some(model),
            tier: None,
            reason: "the run's model".to_string(),
        },
        None => StageModelChoice {
            model: None,
            tier: None,
            reason: "the provider's default model".to_string(),
        },
    }
}

/// Default tier for a stage that did not set one, by what the stage is for.
#[must_use]
pub const fn default_tier_for_stage(
    mutates_worktree: bool,
    satisfies_gate: bool,
) -> WorkflowModelTier {
    if mutates_worktree {
        WorkflowModelTier::Strong
    } else if satisfies_gate {
        WorkflowModelTier::Standard
    } else {
        WorkflowModelTier::Fast
    }
}

/// How an `independentOf` stage runs relative to the stage it judges (FX-BE-164).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IndependenceChoice {
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub independent: bool,
    pub reason: String,
}

/// The judged stage's latest attempt.
#[derive(Debug, Clone, Default)]
pub struct IndependenceAuthor<'a> {
    pub name: &'a str,
    pub provider: Option<&'a str>,
    pub model: Option<&'a str>,
}

/// Inputs to [`choose_independent_stage`].
#[derive(Debug, Clone, Default)]
pub struct IndependenceInput<'a> {
    /// What the stage would run on by the ordinary rules.
    pub provider: &'a str,
    pub model: Option<&'a str>,
    /// `None` when the judged stage has not run.
    pub author: Option<IndependenceAuthor<'a>>,
    /// A person switched this stage's provider or model in this run.
    pub chosen_by_person: bool,
    /// Providers that are set up and enabled, in preference order.
    pub usable_providers: &'a [&'a str],
    pub tiers: Option<&'a ModelTierMap>,
    pub tier: Option<WorkflowModelTier>,
}

/// Picks where an `independentOf` stage runs so it does not mark its own work: another
/// provider when there is one, else another mapped model, else the same model — reported
/// as not independent, never passed off as a second opinion.
#[must_use]
pub fn choose_independent_stage(input: &IndependenceInput<'_>) -> IndependenceChoice {
    let provider = input.provider.to_string();
    let model = input.model.map(str::to_string);
    let choice = |provider: String, model: Option<String>, independent: bool, reason: String| {
        IndependenceChoice {
            provider,
            model,
            independent,
            reason,
        }
    };

    let Some(author) = input
        .author
        .as_ref()
        .filter(|a| a.provider.is_some_and(|p| !p.is_empty()))
    else {
        let name = input
            .author
            .as_ref()
            .map_or("The stage it judges", |a| a.name);
        return choice(
            provider,
            model,
            true,
            format!("{name} has not run, so there is nothing to be independent of yet."),
        );
    };
    let author_provider = author.provider.unwrap_or_default();
    let author_model = author.model.unwrap_or_default();
    let same_model = |candidate: Option<&str>| candidate.unwrap_or_default() == author_model;
    let name = author.name;

    if input.chosen_by_person {
        let independent = input.provider != author_provider || !same_model(input.model);
        let reason = if independent {
            format!("Runs on the AI chosen for it in this run, which differs from {name}'s.")
        } else {
            format!("Not independent: the AI chosen for it in this run is the one {name} used.")
        };
        return choice(provider, model, independent, reason);
    }

    if input.provider != author_provider {
        let reason = format!("Runs on {provider}; {name} ran on {author_provider}.");
        return choice(provider, model, true, reason);
    }

    if let Some(other) = input
        .usable_providers
        .iter()
        .find(|candidate| **candidate != author_provider)
    {
        let mapped = input
            .tier
            .and_then(|tier| mapped_model(input.tiers, other, tier));
        return choice(
            (*other).to_string(),
            mapped,
            true,
            format!(
                "Moved to {other} so it does not mark work {name} produced on {author_provider}."
            ),
        );
    }

    if !same_model(input.model) {
        let shown = input.model.unwrap_or("the default");
        return choice(
            provider,
            model,
            true,
            format!("Same AI as {name}, but a different model ({shown})."),
        );
    }

    let alternative = WORKFLOW_MODEL_TIERS
        .iter()
        .rev()
        .filter_map(|tier| mapped_model(input.tiers, input.provider, *tier))
        .find(|candidate| !same_model(Some(candidate)));
    if let Some(alternative) = alternative {
        let reason = format!(
            "Only {provider} is set up, so it uses a different model ({alternative}) from {name}."
        );
        return choice(provider, Some(alternative), true, reason);
    }
    choice(
        provider,
        model,
        false,
        format!(
            "Not independent: only one model is available, so this is the same AI and model that {name} used. Set up another AI or map a second model tier for a second opinion."
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use WorkflowModelTier::{Fast, Standard, Strong};

    fn tiers() -> ModelTierMap {
        let mut map = ModelTierMap::new();
        map.insert(
            "gw".to_string(),
            BTreeMap::from([
                (Fast, "small".to_string()),
                (Standard, "mid".to_string()),
                (Strong, "big".to_string()),
            ]),
        );
        map
    }

    fn node(model: Option<&str>, tier: Option<WorkflowModelTier>) -> StageModelNode<'_> {
        StageModelNode {
            model,
            model_tier: tier,
            escalate_on_retry: None,
        }
    }

    #[test]
    fn exact_stage_model_beats_tiers_and_run_model() {
        let t = tiers();
        let choice = choose_stage_model(
            node(Some("exact"), Some(Fast)),
            "gw",
            Some(&t),
            Some("run"),
            0,
        );
        assert_eq!(choice.model.as_deref(), Some("exact"));
    }

    #[test]
    fn default_names_no_model() {
        let t = tiers();
        let tiered = choose_stage_model(node(Some("default"), Some(Fast)), "gw", Some(&t), None, 0);
        assert_eq!(tiered.model.as_deref(), Some("small"));
        let unmapped = choose_stage_model(
            node(Some("default"), Some(Strong)),
            "other",
            Some(&t),
            Some(" Default "),
            0,
        );
        assert_eq!(unmapped.model, None);
        assert_eq!(
            choose_stage_model(node(Some("default"), None), "gw", Some(&t), None, 0).model,
            None
        );
    }

    #[test]
    fn tier_resolves_through_provider_mapping_and_unmapped_falls_back() {
        let t = tiers();
        assert_eq!(
            choose_stage_model(node(None, Some(Fast)), "gw", Some(&t), Some("run"), 0)
                .model
                .as_deref(),
            Some("small")
        );
        let fallback =
            choose_stage_model(node(None, Some(Fast)), "other", Some(&t), Some("run"), 0);
        assert_eq!(fallback.model.as_deref(), Some("run"));
        assert!(fallback.reason.contains("no model is mapped"));
        assert_eq!(
            choose_stage_model(node(None, Some(Fast)), "other", Some(&t), None, 0).model,
            None
        );
    }

    #[test]
    fn no_tier_uses_run_model_then_provider_default() {
        let t = tiers();
        assert_eq!(
            choose_stage_model(node(None, None), "gw", Some(&t), Some("run"), 3)
                .model
                .as_deref(),
            Some("run")
        );
        assert_eq!(
            choose_stage_model(node(None, None), "gw", Some(&t), None, 0).model,
            None
        );
    }

    #[test]
    fn each_spent_attempt_moves_one_tier_up_capped_at_strong() {
        let t = tiers();
        let at = |spent| choose_stage_model(node(None, Some(Fast)), "gw", Some(&t), None, spent);
        assert_eq!(at(0).model.as_deref(), Some("small"));
        assert_eq!(at(1).model.as_deref(), Some("mid"));
        assert!(
            at(1)
                .reason
                .contains("raised from fast after 1 failed attempt")
        );
        assert!(!at(1).reason.contains("attempts"));
        assert_eq!(at(2).model.as_deref(), Some("big"));
        assert_eq!(at(5).model.as_deref(), Some("big"));
        assert_eq!(escalate_tier(Strong, 3), Strong);
    }

    #[test]
    fn escalation_can_be_turned_off() {
        let t = tiers();
        let no_escalate = StageModelNode {
            model: None,
            model_tier: Some(Fast),
            escalate_on_retry: Some(false),
        };
        assert_eq!(
            choose_stage_model(no_escalate, "gw", Some(&t), None, 2)
                .model
                .as_deref(),
            Some("small")
        );
    }

    #[test]
    fn default_tiers_follow_what_the_stage_does() {
        assert_eq!(default_tier_for_stage(true, false), Strong);
        assert_eq!(default_tier_for_stage(false, true), Standard);
        assert_eq!(default_tier_for_stage(false, false), Fast);
        assert_eq!(parse_model_tier("standard"), Some(Standard));
        assert_eq!(parse_model_tier("huge"), None);
    }

    fn author<'a>(
        provider: Option<&'a str>,
        model: Option<&'a str>,
    ) -> Option<IndependenceAuthor<'a>> {
        Some(IndependenceAuthor {
            name: "Implement",
            provider,
            model,
        })
    }

    #[test]
    fn independent_different_provider_stands() {
        let choice = choose_independent_stage(&IndependenceInput {
            provider: "openai",
            author: author(Some("claude"), None),
            usable_providers: &["openai", "claude"],
            ..Default::default()
        });
        assert_eq!(
            (choice.provider.as_str(), choice.independent),
            ("openai", true)
        );
    }

    #[test]
    fn independent_moves_to_another_provider_with_its_tier_model() {
        let mut t = ModelTierMap::new();
        t.insert(
            "openai".to_string(),
            BTreeMap::from([(Standard, "gpt-y".to_string())]),
        );
        let choice = choose_independent_stage(&IndependenceInput {
            provider: "claude",
            model: Some("claude-x"),
            author: author(Some("claude"), Some("claude-x")),
            usable_providers: &["claude", "openai"],
            tiers: Some(&t),
            tier: Some(Standard),
            ..Default::default()
        });
        assert_eq!(
            (
                choice.provider.as_str(),
                choice.model.as_deref(),
                choice.independent
            ),
            ("openai", Some("gpt-y"), true)
        );
        assert!(choice.reason.contains("Moved to openai"));
    }

    #[test]
    fn independent_with_one_provider_uses_a_different_mapped_model() {
        let mut t = ModelTierMap::new();
        t.insert(
            "claude".to_string(),
            BTreeMap::from([
                (Strong, "claude-strong".to_string()),
                (Standard, "claude-standard".to_string()),
            ]),
        );
        let choice = choose_independent_stage(&IndependenceInput {
            provider: "claude",
            model: Some("claude-strong"),
            author: author(Some("claude"), Some("claude-strong")),
            usable_providers: &["claude"],
            tiers: Some(&t),
            ..Default::default()
        });
        assert_eq!(
            (
                choice.provider.as_str(),
                choice.model.as_deref(),
                choice.independent
            ),
            ("claude", Some("claude-standard"), true)
        );
    }

    #[test]
    fn independent_with_one_model_says_so_respects_people_and_unrun_authors() {
        let alone = choose_independent_stage(&IndependenceInput {
            provider: "claude",
            author: author(Some("claude"), None),
            usable_providers: &["claude"],
            ..Default::default()
        });
        assert!(!alone.independent);
        assert!(alone.reason.starts_with("Not independent"));

        let chosen = choose_independent_stage(&IndependenceInput {
            provider: "claude",
            author: author(Some("claude"), None),
            chosen_by_person: true,
            usable_providers: &["claude", "openai"],
            ..Default::default()
        });
        assert_eq!(
            (chosen.provider.as_str(), chosen.independent),
            ("claude", false)
        );

        let unrun = choose_independent_stage(&IndependenceInput {
            provider: "claude",
            author: author(None, None),
            usable_providers: &["claude", "openai"],
            ..Default::default()
        });
        assert_eq!(
            (unrun.provider.as_str(), unrun.independent),
            ("claude", true)
        );
    }
}
