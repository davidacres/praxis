/**
 * Canonical template definitions for markdown issue files.
 *
 * Provides a single source of truth for the expected front-matter fields
 * and sections per issue type. Used by both file creation (buildIssueMarkdown)
 * and file upgrade (upgradeMarkdownFile) to ensure consistency.
 */

// ── Types ────────────────────────────────────────────────────────────

export type IssueType = 'Feature' | 'Idea' | 'Story' | 'Task' | 'Bug';

export interface FieldRule {
  /** The bold-line field name (without `**` wrapping). */
  name: string;
  /**
   * Default value when the field is created.
   * Use `null` for fields whose value is computed at runtime (e.g. Created date).
   * Use empty string for "present but empty" fields.
   */
  defaultValue: string | null;
  /** Issue types this field applies to. If omitted, applies to all. */
  appliesTo?: IssueType[];
  /** Where to insert: 'core' = right after title; 'tail' = end of header block. */
  position: 'core' | 'tail';
  /** If true, field is added during creation. Defaults to true. */
  onCreate?: boolean;
  /** If true, field is added during upgrade when missing. Defaults to true. */
  onUpgrade?: boolean;
}

export interface SectionRule {
  /** The `## Heading` name. */
  name: string;
  /** Default body content lines (joined with newlines). */
  defaultBody: string[];
  /** Issue types this section applies to. If omitted, applies to all. */
  appliesTo?: IssueType[];
  /** Aliases: if any of these section names are already present, this section is considered satisfied. */
  aliases?: string[];
  /** If true, section is added during creation. Defaults to true. */
  onCreate?: boolean;
  /** If true, section is added during upgrade when missing. Defaults to true. */
  onUpgrade?: boolean;
  /** If true, rename legacy alias heading to canonical name on upgrade. Defaults to false. */
  renameAliasOnUpgrade?: boolean;
}

// ── Field definitions ────────────────────────────────────────────────

export const FIELD_RULES: readonly FieldRule[] = [
  // Core fields (inserted right after title)
  { name: 'Status', defaultValue: '📋 Proposed', position: 'core' },
  { name: 'Created', defaultValue: null, position: 'core' },
  { name: 'Type', defaultValue: null, position: 'core' },
  { name: 'Priority', defaultValue: 'Medium', position: 'core' },
  // Model: added on create if configured, never on upgrade
  { name: 'Model', defaultValue: null, position: 'core', onUpgrade: false },
  // Bug-specific fields (inserted at end of header block)
  { name: 'Severity', defaultValue: 'Medium', position: 'tail', appliesTo: ['Bug'] },
  { name: 'Reported By', defaultValue: '', position: 'tail', appliesTo: ['Bug'] },
];

// ── Section definitions ──────────────────────────────────────────────

export const SECTION_RULES: readonly SectionRule[] = [
  {
    name: 'Description',
    defaultBody: [''],
    aliases: ['Summary', 'Deliverables'],
    renameAliasOnUpgrade: true,
  },
  {
    name: 'Items',
    defaultBody: ['', '| Ref | Type | Name | Status |', '| --- | --- | --- | --- |', ''],
    appliesTo: ['Feature'],
    aliases: ['Stories'],
  },
  {
    name: 'Research Transcript',
    defaultBody: [''],
    appliesTo: ['Idea'],
  },
  {
    name: 'Steps to Reproduce',
    defaultBody: ['1. ', ''],
    appliesTo: ['Bug'],
  },
  {
    name: 'Expected Behavior',
    defaultBody: ['', ''],
    appliesTo: ['Bug'],
  },
  {
    name: 'Actual Behavior',
    defaultBody: ['', ''],
    appliesTo: ['Bug'],
  },
  {
    name: 'Dependencies',
    defaultBody: ['', ''],
  },
  {
    name: 'Comments',
    defaultBody: ['', ''],
  },
];

// ── Helpers ──────────────────────────────────────────────────────────

function fieldApplies(rule: FieldRule, issueType: IssueType): boolean {
  if (rule.appliesTo && !rule.appliesTo.includes(issueType)) {
    return false;
  }
  return true;
}

function sectionApplies(rule: SectionRule, issueType: IssueType): boolean {
  if (rule.appliesTo && !rule.appliesTo.includes(issueType)) {
    return false;
  }
  return true;
}

// ── Generate new issue markdown ──────────────────────────────────────

export interface GenerateOptions {
  description?: string;
  ideaTranscript?: string;
  createdAt?: string;
  parentKey?: string;
  model?: string;
  /** Header field values that replace a rule's default on creation, by field name (e.g. `Priority`). */
  fieldValues?: Record<string, string>;
  /** Section bodies that replace a rule's default body on creation, by section name. */
  sectionBodies?: Record<string, string>;
}

function buildDefaultDescription(issueType: IssueType): string {
  switch (issueType) {
    case 'Feature':
      return 'Describe the feature goals and scope.';
    case 'Idea':
      return 'Describe the idea, opportunity, and research context.';
    case 'Story':
      return 'Describe the user story and acceptance criteria.';
    case 'Task':
      return 'Describe what needs to be done.';
    case 'Bug':
      return '';
    default:
      return '';
  }
}

/**
 * Generate a full markdown file for a new issue from the template rules.
 */
export function generateIssueMarkdown(
  issueType: IssueType,
  title: string,
  opts: GenerateOptions = {}
): string {
  const createdAt = opts.createdAt ?? new Date().toISOString();
  const lines: string[] = [`# ${title}`, ''];

  // Emit fields
  for (const rule of FIELD_RULES) {
    if (!fieldApplies(rule, issueType)) {
      continue;
    }
    if (rule.onCreate === false) {
      continue;
    }

    let value: string | undefined;
    switch (rule.name) {
      case 'Created':
        value = createdAt;
        break;
      case 'Type':
        value = issueType;
        break;
      case 'Model':
        value = opts.model;
        if (!value) { continue; }
        break;
      default:
        value = opts.fieldValues?.[rule.name]?.trim() || (rule.defaultValue ?? '');
        break;
    }
    lines.push(`**${rule.name}:**${value ? ` ${value}` : ''}`);
  }

  // Parent (creation-only, not part of template rules)
  if (opts.parentKey) {
    lines.push(`**Parent:** ${opts.parentKey}`);
  }

  lines.push('');

  // Emit sections
  let isFirstSection = true;
  for (const rule of SECTION_RULES) {
    if (!sectionApplies(rule, issueType)) {
      continue;
    }
    if (rule.onCreate === false) {
      continue;
    }

    if (!isFirstSection) {
      // Ensure blank line separator before each section (after the first)
      if (lines[lines.length - 1] !== '') {
        lines.push('');
      }
    }
    isFirstSection = false;

    lines.push(`## ${rule.name}`);
    if (rule.name === 'Description') {
      lines.push(opts.description?.trim() || buildDefaultDescription(issueType));
    } else if (rule.name === 'Research Transcript') {
      lines.push(opts.ideaTranscript?.trim() || '');
    } else if (opts.sectionBodies?.[rule.name]?.trim()) {
      lines.push(opts.sectionBodies[rule.name].trim(), '');
    } else {
      lines.push(...rule.defaultBody);
    }
  }

  // Ensure trailing newline
  if (lines[lines.length - 1] !== '') {
    lines.push('');
  }

  return lines.join('\n');
}

// ── Ensure front matter on existing content ──────────────────────────

/**
 * Given existing markdown content and an issue type, adds any missing
 * front-matter fields and sections without disturbing existing content.
 * Returns the updated content string, or the original if nothing changed.
 */
export function ensureFrontMatter(content: string, issueType: IssueType): string {
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  let modified = false;

  // ── Locate the header block (between title and first ## heading) ──
  let firstHeadingIdx = lines.findIndex((l, i) => i > 0 && /^## /.test(l));
  let headerEnd = firstHeadingIdx >= 0 ? firstHeadingIdx : lines.length;

  const hasField = (field: string): boolean =>
    lines.slice(0, headerEnd).some(l => l.startsWith(`**${field}:**`));

  // ── Insert core fields right after the title ──
  let coreInsertIdx = 1;
  while (coreInsertIdx < headerEnd && lines[coreInsertIdx].trim() === '') {
    coreInsertIdx++;
  }

  const coreFields: string[] = [];
  for (const rule of FIELD_RULES) {
    if (rule.position !== 'core') { continue; }
    if (!fieldApplies(rule, issueType)) { continue; }
    if (rule.onUpgrade === false) { continue; }
    if (hasField(rule.name)) { continue; }

    let value: string;
    switch (rule.name) {
      case 'Created':
        value = new Date().toISOString();
        break;
      case 'Type':
        value = issueType;
        break;
      default:
        value = rule.defaultValue ?? '';
        break;
    }
    coreFields.push(`**${rule.name}:**${value ? ` ${value}` : ''}`);
  }

  if (coreFields.length > 0) {
    lines.splice(coreInsertIdx, 0, ...coreFields);
    modified = true;
    // Recalculate headerEnd
    firstHeadingIdx = lines.findIndex((l, i) => i > 0 && /^## /.test(l));
    headerEnd = firstHeadingIdx >= 0 ? firstHeadingIdx : lines.length;
  }

  // ── Insert optional/tail fields at end of header block ──
  let tailInsertIdx = headerEnd;
  while (tailInsertIdx > 0 && lines[tailInsertIdx - 1].trim() === '') {
    tailInsertIdx--;
  }

  const tailFields: string[] = [];
  for (const rule of FIELD_RULES) {
    if (rule.position !== 'tail') { continue; }
    if (!fieldApplies(rule, issueType)) { continue; }
    if (rule.onUpgrade === false) { continue; }
    if (hasField(rule.name)) { continue; }

    const value = rule.defaultValue ?? '';
    tailFields.push(`**${rule.name}:**${value ? ` ${value}` : ''}`);
  }

  if (tailFields.length > 0) {
    lines.splice(tailInsertIdx, 0, ...tailFields);
    modified = true;
  }

  // ── Section upgrades ──
  const hasSection = (name: string): boolean =>
    lines.some(l => new RegExp(`^##\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(l));

  // Handle alias renames first
  for (const rule of SECTION_RULES) {
    if (!sectionApplies(rule, issueType)) { continue; }
    if (!rule.renameAliasOnUpgrade) { continue; }
    if (hasSection(rule.name)) { continue; }

    // Check if an alias is present and rename it
    if (rule.aliases) {
      for (const alias of rule.aliases) {
        const aliasIdx = lines.findIndex(l =>
          new RegExp(`^##\\s+${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(l)
        );
        if (aliasIdx >= 0) {
          lines[aliasIdx] = `## ${rule.name}`;
          modified = true;
          break;
        }
      }
    }
  }

  // Add missing sections at the end
  const sectionsToAdd: string[][] = [];

  for (const rule of SECTION_RULES) {
    if (!sectionApplies(rule, issueType)) { continue; }
    if (rule.onUpgrade === false) { continue; }
    if (hasSection(rule.name)) { continue; }

    // Check aliases — if any alias exists, section is satisfied
    const aliasPresent = rule.aliases?.some(alias => hasSection(alias)) ?? false;
    if (aliasPresent) { continue; }

    sectionsToAdd.push([`## ${rule.name}`, ...rule.defaultBody]);
  }

  if (sectionsToAdd.length > 0) {
    // Trim trailing blank lines
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
      lines.pop();
    }
    for (const section of sectionsToAdd) {
      lines.push('', ...section);
    }
    lines.push('');
    modified = true;
  }

  if (!modified) {
    return content;
  }
  return lines.join('\n');
}
