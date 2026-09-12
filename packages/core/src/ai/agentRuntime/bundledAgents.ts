/**
 * Bundled trusted agent manifests and briefs (FX-BE-090 / TASK-247).
 *
 * Ships four canonical agents in the app image:
 * - praxis-planner
 * - praxis-implementer
 * - praxis-reviewer
 * - praxis-security-analyst
 *
 * Marked trusted because they ship with the app, mirrored into the user's
 * trusted discovery root on first run, and never written into project folders.
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentManifest, DiscoveredAgent } from './manifest';
import {
  STRUCTURED_CODE_REVIEW_SYSTEM_PROMPT
} from '../aiReviewService';

export const STRUCTURED_SECURITY_REVIEW_SYSTEM_PROMPT = `You are a security engineer performing a structured security review.
Analyze the implementation context and diff for security vulnerabilities:
1. OWASP Top 10 vulnerabilities (injection, XSS, CSRF, etc.)
2. Authentication and authorization issues
3. Data exposure or sensitive data leakage
4. Input validation and serialization flaws
5. Dependency or supply chain concerns
6. Secrets or credential handling

Return your review as exactly one fenced JSON code block in this format:

\`\`\`json
{
  "summary": "Concise summary of security assessment",
  "findings": [
    {
      "file": "path/to/file",
      "line": 42,
      "severity": "critical" | "high" | "medium" | "low" | "info",
      "category": "security",
      "message": "Specific explanation of the security issue",
      "suggestion": "Concrete actionable remediation"
    }
  ],
  "metrics": {
    "filesReviewed": 5,
    "issuesFound": 1
  }
}
\`\`\`

Rules:
- You must include the fenced JSON block with "findings" array, even if empty (0 findings).
- You may include concise prose summary outside the JSON block.
- Each finding must specify valid severity (critical/high/medium/low/info).
- Category should be "security".
`;

export interface BundledAgentDefinition {
  manifest: AgentManifest;
  brief: string;
}

export const BUNDLED_AGENT_DEFINITIONS: Record<string, BundledAgentDefinition> = {
  'praxis-planner': {
    manifest: {
      schemaVersion: 1,
      id: 'praxis-planner',
      name: 'Praxis Planner',
      type: 'acp',
      entry: 'praxis-planner'
    },
    brief: `# Praxis Planner

You are the Praxis planning agent.
Analyze ticket briefs, repository architecture, and user goals.
Break work down into structured, actionable tasks with clear acceptance criteria and dependencies.
Follow repository planning conventions and output markdown plan specifications.`
  },

  'praxis-implementer': {
    manifest: {
      schemaVersion: 1,
      id: 'praxis-implementer',
      name: 'Praxis Implementer',
      type: 'acp',
      entry: 'praxis-implementer'
    },
    brief: `# Praxis Implementer

You are the Praxis implementation agent.
Implement requested changes surgically with minimal diffs and adherence to existing repo architecture.
Verify your changes locally using available build, lint, and test tools.
Output clean git commit changesets with descriptive commit messages.`
  },

  'praxis-reviewer': {
    manifest: {
      schemaVersion: 1,
      id: 'praxis-reviewer',
      name: 'Praxis Reviewer',
      type: 'acp',
      entry: 'praxis-reviewer'
    },
    brief: STRUCTURED_CODE_REVIEW_SYSTEM_PROMPT
  },

  'praxis-security-analyst': {
    manifest: {
      schemaVersion: 1,
      id: 'praxis-security-analyst',
      name: 'Praxis Security Analyst',
      type: 'acp',
      entry: 'praxis-security-analyst'
    },
    brief: STRUCTURED_SECURITY_REVIEW_SYSTEM_PROMPT
  },

  'praxis-addon-builder': {
    manifest: {
      schemaVersion: 1,
      id: 'praxis-addon-builder',
      name: 'Praxis Add-on Builder',
      type: 'acp',
      entry: 'praxis-addon-builder'
    },
    brief: `# Praxis Add-on Builder

You are the Praxis add-on development agent.
You understand how to build, validate, package, and publish add-ons for Praxis (themes, surface-packs, agents, and workflow-templates).
You construct valid npm package.json manifests with the praxis schema, assemble required payloads in addon/, and verify packaging integrity.`
  }
};

export const CSHARP_CODE_REVIEW_SYSTEM_PROMPT = `You are a senior .NET and C# software engineer and architect performing a structured code review.
Analyze the implementation context and diff for C#/.NET best practices:
1. SOLID principles (Single Responsibility, Open/Closed, Liskov Substitution, Interface Segregation, Dependency Inversion)
2. DRY principle (Don't Repeat Yourself)
3. Idiomatic modern C# (LINQ, async/await, memory allocation, disposal patterns)
4. Nullability, exception handling, and resource safety
5. Unit testability and clean architecture

Return your review as exactly one fenced JSON code block in this format:

\`\`\`json
{
  "summary": "Concise summary of C#/.NET code review",
  "findings": [
    {
      "file": "path/to/file.cs",
      "line": 42,
      "severity": "critical" | "high" | "medium" | "low" | "info",
      "category": "quality",
      "message": "Specific explanation of the C#/.NET design or code issue",
      "suggestion": "Concrete actionable remediation adhering to SOLID/DRY principles"
    }
  ],
  "metrics": {
    "filesReviewed": 5,
    "issuesFound": 1
  }
}
\`\`\`

Rules:
- You must include the fenced JSON block with "findings" array, even if empty (0 findings).
- You may include concise prose summary outside the JSON block.
- Each finding must specify valid severity (critical/high/medium/low/info).
- Category should be "quality".
`;

/**
 * Extended catalog of available agents that can be automatically installed
 * when a workflow requiring them is instantiated.
 */
export const AVAILABLE_AGENT_DEFINITIONS: Record<string, BundledAgentDefinition> = {
  ...BUNDLED_AGENT_DEFINITIONS,
  'csharp-dotnet-code-reviewer': {
    manifest: {
      schemaVersion: 1,
      id: 'csharp-dotnet-code-reviewer',
      name: 'C# .NET Code Reviewer',
      type: 'acp',
      entry: 'praxis-reviewer'
    },
    brief: CSHARP_CODE_REVIEW_SYSTEM_PROMPT
  }
};

export interface AvailableSkillDefinition {
  name: string;
  description: string;
  triggers: string[];
  version?: string;
  instructions: string;
}

/**
 * Extended catalog of available skills that can be automatically installed
 * into the skills registry when a workflow requiring them is instantiated.
 */
export const AVAILABLE_SKILL_DEFINITIONS: Record<string, AvailableSkillDefinition> = {
  'dotnet-solid-dry': {
    name: 'dotnet-solid-dry',
    description: 'C# and .NET code review principles focusing on SOLID design and DRY architecture.',
    triggers: ['csharp', 'dotnet', 'solid', 'dry', 'c#'],
    version: '1.0.0',
    instructions: `---
name: dotnet-solid-dry
description: "C# and .NET code review principles focusing on SOLID design and DRY architecture."
triggers: csharp, dotnet, solid, dry, c#
version: 1.0.0
---

# .NET SOLID & DRY Code Review Skill

When reviewing .NET and C# code, evaluate:
1. **Single Responsibility Principle (SRP)**: Ensure classes and methods have a single well-defined responsibility.
2. **Open/Closed Principle (OCP)**: Code should be open for extension but closed for modification.
3. **Liskov Substitution Principle (LSP)**: Derived classes must be completely substitutable for their base types.
4. **Interface Segregation Principle (ISP)**: Favor fine-grained, cohesive interfaces over fat ones.
5. **Dependency Inversion Principle (DIP)**: Depend on abstractions, not concrete implementations. Verify dependency injection usage.
6. **Don't Repeat Yourself (DRY)**: Eliminate duplicated logic and boilerplate across the solution.
`
  }
};

/**
 * Installs an available agent definition into the given target directory (e.g. userData/agents).
 */
export async function installAvailableAgent(agentId: string, targetAgentsDir: string): Promise<boolean> {
  const def = AVAILABLE_AGENT_DEFINITIONS[agentId];
  if (!def) return false;
  const agentDir = path.join(targetAgentsDir, agentId);
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(agentDir, 'agent.json'), JSON.stringify(def.manifest, null, 2), 'utf8');
  await writeFile(path.join(agentDir, 'brief.md'), def.brief, 'utf8');
  return true;
}

/**
 * Installs an available skill definition into the given target directory (e.g. userData/skills).
 */
export async function installAvailableSkill(skillName: string, targetSkillsDir: string): Promise<boolean> {
  const def = AVAILABLE_SKILL_DEFINITIONS[skillName];
  if (!def) return false;
  const skillDir = path.join(targetSkillsDir, skillName);
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, 'SKILL.md'), def.instructions, 'utf8');
  return true;
}

/** Returns synthetic DiscoveredAgent instances for all bundled agents. */
export function getBundledAgentManifests(): DiscoveredAgent[] {
  return Object.values(BUNDLED_AGENT_DEFINITIONS).map(def => ({
    manifest: def.manifest,
    manifestPath: path.join('/bundled', def.manifest.id, 'agent.json'),
    rootPath: path.join('/bundled', def.manifest.id),
    scope: 'global' as const,
    trusted: true,
    errors: []
  }));
}

/**
 * Mirrors bundled agent manifests into the trusted discovery root on first-run.
 * Idempotent: writes files if absent or updates them safely without touching user projects.
 */
export async function mirrorBundledAgents(targetDir: string): Promise<string[]> {
  const mirrored: string[] = [];
  try {
    await mkdir(targetDir, { recursive: true });
  } catch {
    // Already exists or root path
  }

  for (const [id, def] of Object.entries(BUNDLED_AGENT_DEFINITIONS)) {
    const agentDir = path.join(targetDir, id);
    try {
      await mkdir(agentDir, { recursive: true });
      const manifestFile = path.join(agentDir, 'agent.json');
      const briefFile = path.join(agentDir, 'brief.md');

      let shouldWriteManifest = true;
      try {
        const existing = await readFile(manifestFile, 'utf8');
        const parsed = JSON.parse(existing) as { id?: string };
        if (parsed.id === id) {
          shouldWriteManifest = false;
        }
      } catch {
        shouldWriteManifest = true;
      }

      if (shouldWriteManifest) {
        await writeFile(manifestFile, JSON.stringify(def.manifest, null, 2), 'utf8');
      }
      try {
        await writeFile(briefFile, def.brief, { encoding: 'utf8', flag: 'wx' });
      } catch {
        // brief already exists, preserve
      }
      mirrored.push(id);
    } catch {
      // Best-effort mirror
    }
  }

  return mirrored;
}
