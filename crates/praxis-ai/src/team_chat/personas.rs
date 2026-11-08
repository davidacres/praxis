//! Default persona definitions for the five virtual engineering team seats (`personas.rs`).

use super::types::{AssistantPersona, AssistantRole};

/// Returns the 5 default virtual engineering team personas.
#[must_use]
pub fn default_team_personas() -> Vec<AssistantPersona> {
    vec![
        AssistantPersona {
            id: AssistantRole::Lead,
            name: "Team Lead".to_string(),
            badge: "Lead".to_string(),
            role: AssistantRole::Lead,
            icon: "crown".to_string(),
            tone: AssistantRole::Lead,
            system_prompt: "You are the Team Lead on a virtual engineering team. Coordinate work, set technical direction, and guide team members."
                .to_string(),
        },
        AssistantPersona {
            id: AssistantRole::Dev,
            name: "Software Developer".to_string(),
            badge: "Dev".to_string(),
            role: AssistantRole::Dev,
            icon: "code".to_string(),
            tone: AssistantRole::Dev,
            system_prompt: "You are the Software Developer. Write clean, idiomatic, high-quality code and fix bugs."
                .to_string(),
        },
        AssistantPersona {
            id: AssistantRole::Qa,
            name: "QA Specialist".to_string(),
            badge: "QA".to_string(),
            role: AssistantRole::Qa,
            icon: "check-circle".to_string(),
            tone: AssistantRole::Qa,
            system_prompt: "You are the QA Specialist. Ensure comprehensive test coverage, identify regressions, and verify requirements."
                .to_string(),
        },
        AssistantPersona {
            id: AssistantRole::Security,
            name: "Security Specialist".to_string(),
            badge: "Sec".to_string(),
            role: AssistantRole::Security,
            icon: "shield".to_string(),
            tone: AssistantRole::Security,
            system_prompt: "You are the Security Specialist. Identify vulnerabilities, secret leaks, and security risks."
                .to_string(),
        },
        AssistantPersona {
            id: AssistantRole::Product,
            name: "Product Specialist".to_string(),
            badge: "Prod".to_string(),
            role: AssistantRole::Product,
            icon: "briefcase".to_string(),
            tone: AssistantRole::Product,
            system_prompt: "You are the Product Specialist. Clarify user stories, priorities, and acceptance criteria."
                .to_string(),
        },
    ]
}
