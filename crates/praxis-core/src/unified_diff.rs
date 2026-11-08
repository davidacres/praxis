//! Minimal unified diff generation for reviewing agent file writes (`unifiedDiff.ts` port).

/// Default context line count around a changed span in [`create_unified_diff`].
pub const DEFAULT_DIFF_CONTEXT: usize = 3;

/// Minimal unified-diff generator for reviewing agent file writes (`createUnifiedDiff` port).
///
/// Trims common leading/trailing lines and emits the changed span as a single
/// hunk with `context` lines of surrounding context.
#[must_use]
pub fn create_unified_diff(file_path: &str, before: &str, after: &str, context: usize) -> String {
    if before == after {
        return String::new();
    }

    let before_lines = split_lines(before);
    let after_lines = split_lines(after);

    let mut start = 0usize;
    let max_start = before_lines.len().min(after_lines.len());
    while start < max_start && before_lines[start] == after_lines[start] {
        start += 1;
    }

    let mut end_before = before_lines.len();
    let mut end_after = after_lines.len();
    while end_before > start
        && end_after > start
        && before_lines[end_before - 1] == after_lines[end_after - 1]
    {
        end_before -= 1;
        end_after -= 1;
    }

    let ctx_start = start.saturating_sub(context);
    let ctx_end_before = before_lines.len().min(end_before + context);
    let ctx_end_after = after_lines.len().min(end_after + context);

    let old_count = ctx_end_before - ctx_start;
    let new_count = ctx_end_after - ctx_start;

    let mut lines: Vec<String> = vec![
        format!("--- {file_path}"),
        format!("+++ {file_path}"),
        format!(
            "@@ -{},{} +{},{} @@",
            ctx_start + 1,
            old_count,
            ctx_start + 1,
            new_count
        ),
    ];

    for line in &before_lines[ctx_start..start] {
        lines.push(format!(" {line}"));
    }
    for line in &before_lines[start..end_before] {
        lines.push(format!("-{line}"));
    }
    for line in &after_lines[start..end_after] {
        lines.push(format!("+{line}"));
    }
    for line in &before_lines[end_before..ctx_end_before] {
        lines.push(format!(" {line}"));
    }

    format!("{}\n", lines.join("\n"))
}

fn split_lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut lines: Vec<&str> = text.split('\n').collect();
    // A trailing newline produces a final empty element; drop it so it is not shown as a line.
    if lines.last().copied() == Some("") {
        lines.pop();
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_empty_string_when_content_is_unchanged() {
        assert_eq!(
            create_unified_diff("a.txt", "same\n", "same\n", DEFAULT_DIFF_CONTEXT),
            ""
        );
    }

    #[test]
    fn emits_addition_hunk_for_new_file() {
        let diff =
            create_unified_diff("notes.md", "", "line one\nline two\n", DEFAULT_DIFF_CONTEXT);
        assert!(diff.starts_with("--- notes.md\n+++ notes.md\n"));
        assert!(diff.contains("\n+line one\n"));
        assert!(diff.contains("\n+line two\n"));
        assert!(!diff.contains("\n-"));
    }

    #[test]
    fn emits_deletions_and_additions_for_modified_region_with_context() {
        let before = "a\nb\nc\nd\ne\n";
        let after = "a\nb\nCHANGED\nd\ne\n";
        let diff = create_unified_diff("f.txt", before, after, DEFAULT_DIFF_CONTEXT);
        assert!(diff.contains("\n-c\n"));
        assert!(diff.contains("\n+CHANGED\n"));
        assert!(diff.contains("\n b\n"));
        assert!(diff.contains("\n d\n"));
    }

    #[test]
    fn hunk_header_line_counts_match_emitted_body() {
        let diff = create_unified_diff("f.txt", "a\nb\nc\n", "a\nX\nc\n", DEFAULT_DIFF_CONTEXT);
        let lines: Vec<&str> = diff.lines().collect();
        assert_eq!(lines[2], "@@ -1,3 +1,3 @@");
        let body = &lines[3..];
        let old_lines = body
            .iter()
            .filter(|l| l.starts_with(' ') || l.starts_with('-'))
            .count();
        let new_lines = body
            .iter()
            .filter(|l| l.starts_with(' ') || l.starts_with('+'))
            .count();
        assert_eq!((old_lines, new_lines), (3, 3));
    }

    #[test]
    fn handles_deletion_to_empty_and_limits_context() {
        assert_eq!(
            create_unified_diff("f.txt", "a\nb\n", "", DEFAULT_DIFF_CONTEXT),
            "--- f.txt\n+++ f.txt\n@@ -1,2 +1,0 @@\n-a\n-b\n"
        );
        let before = "1\n2\n3\n4\n5\n6\n7\n8\n9\n";
        let after = "1\n2\n3\n4\nX\n6\n7\n8\n9\n";
        assert_eq!(
            create_unified_diff("f.txt", before, after, 1),
            "--- f.txt\n+++ f.txt\n@@ -4,3 +4,3 @@\n 4\n-5\n+X\n 6\n"
        );
    }
}
