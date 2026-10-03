---
**Status:** 📋 Proposed
**Created:** 2026-10-03T00:00:00.000Z
**Type:** Task
**Priority:** High
id: TASK-401
type: Task
status: Backlog
created: 2026-10-03
priority: High
---

# Assistant persona definitions and multi-agent system prompts in core

## Files and integration points

- `packages/core/src/ai/assistant/assistantTypes.ts` (new): Defines `AssistantRole` (`'lead' | 'dev' | 'qa' | 'security' | 'product' | 'user'`), `AssistantPersona`, `AssistantMessage`, `PageAssistantContext`, and `AssistantChoiceOption`.
- `packages/core/src/ai/assistant/assistantPersonas.ts` (new): Declares default personas, role display metadata (icons, brand tones, labels), and base domain system prompts.
- `packages/core/src/index.ts`: Exports shared assistant types for consumption by desktop main and renderer.

## Implementation details

- Each persona has:
  - `id`: Unique identifier (e.g., `'lead'`, `'dev'`, `'qa'`, `'security'`, `'product'`).
  - `name`: Display name (e.g., `'Tech Lead'`, `'Senior Dev'`, `'QA Specialist'`, `'Security Engineer'`).
  - `role`: Role discriminator.
  - `icon`: Praxis `IconName` (`'compass'`, `'code'`, `'check-circle'`, `'shield'`, `'list'`).
  - `tone`: Visual tone token corresponding to theme variables.
  - `systemPrompt`: Rigorous system prompt focusing the model on domain-specific critique and actionable recommendations.
- Prompts instruct the model to produce concise answers, flag critical edge cases, and optionally return structured decision choices or proposals.

## Testing and verification criteria

- Core unit test verifying default persona registry completeness, valid icons, and non-empty system prompts.
- Export checks ensuring all types compile cleanly under `npm run check-types`.
