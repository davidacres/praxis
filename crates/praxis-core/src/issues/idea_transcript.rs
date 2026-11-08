//! Idea description and research transcript splitting/composition (`packages/core/src/issues/ideaTranscript.ts`).

fn normalize_line_endings(value: &str) -> String {
    value.replace("\r\n", "\n")
}

fn extract_section_body(content: &str, heading: &str) -> Option<String> {
    let normalized = normalize_line_endings(content);
    let lines: Vec<&str> = normalized.split('\n').collect();
    let target = format!("## {heading}");
    let mut index = 0;
    while index < lines.len() {
        if lines[index].trim() == target {
            index += 1;
            let mut body = Vec::new();
            while index < lines.len() && !lines[index].starts_with("## ") {
                body.push(lines[index]);
                index += 1;
            }
            let value = body.join("\n").trim().to_string();
            return if value.is_empty() { None } else { Some(value) };
        }
        index += 1;
    }
    None
}

/// Extracted `Description` and `Research Transcript` sections for an `Idea` issue.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IdeaTranscriptSections {
    pub description: Option<String>,
    pub idea_transcript: Option<String>,
}

/// Splits an `Idea` issue's content into its description and research transcript sections.
#[must_use]
pub fn split_idea_content(content: Option<&str>) -> IdeaTranscriptSections {
    let trimmed = content.unwrap_or("").trim();
    if trimmed.is_empty() {
        return IdeaTranscriptSections::default();
    }

    let description = extract_section_body(trimmed, "Description")
        .or_else(|| extract_section_body(trimmed, "Idea Details"))
        .or_else(|| Some(trimmed.to_string()));
    let idea_transcript = extract_section_body(trimmed, "Research Transcript")
        .or_else(|| extract_section_body(trimmed, "AI Research Transcript"));

    IdeaTranscriptSections {
        description,
        idea_transcript,
    }
}

/// Composes `## Description` and `## Research Transcript` sections for an `Idea` markdown file.
#[must_use]
pub fn compose_idea_content(
    description: Option<&str>,
    idea_transcript: Option<&str>,
) -> Option<String> {
    let details = description.unwrap_or("").trim();
    let transcript = idea_transcript.unwrap_or("").trim();

    if details.is_empty() && transcript.is_empty() {
        return None;
    }

    let mut lines = Vec::new();
    if !details.is_empty() {
        lines.push("## Description".to_string());
        lines.push(details.to_string());
    }
    if !transcript.is_empty() {
        if !lines.is_empty() {
            lines.push(String::new());
        }
        lines.push("## Research Transcript".to_string());
        lines.push(transcript.to_string());
    }
    Some(lines.join("\n"))
}
