# FX-BF-042 — Chat turn telemetry, live AI activity, and reasoning UX

**Type:** Feature
**Status:** Complete
**Owner:** Electron desktop app

## Outcome

Praxis Desktop provides real-time visibility into AI turn execution, dynamic reasoning
streaming, and comprehensive message-level metrics (timestamp, duration, token usage,
turn cost, model identity, tool run summaries, and copy actions).

## Stories

- [FX-BE-133 — Live AI activity telemetry and reasoning inspector streaming](stories/fx-be-133-live-ai-activity-telemetry-and-reasoning-inspector/issue.md)
- [FX-BE-134 — Per-message turn metrics, duration, token usage, and cost attribution](stories/fx-be-134-message-turn-metrics-duration-tokens-and-cost/issue.md)
- [FX-BE-135 — Chat usability enhancements, tool execution summary, and message actions](stories/fx-be-135-tool-execution-summary-and-message-actions/issue.md)

## Close condition

Live turn timers and activity status update during model processing, reasoning streams
reliably in the Details pane without premature truncation, misplaced chat reasoning
bubbles are gone, and messages present timestamps, duration, tokens, cost, tool
summaries, and copy buttons cleanly.
