---
name: praxis-addon-builder
description: Guide and tool for building, validating, packaging, and publishing Praxis add-ons for themes, surface packs, agents, and workflow templates.
triggers: build addon, create addon, publish addon, theme addon, workflow addon, agent addon, surface pack addon
---

# Praxis Add-on Builder Skill

This skill guides AI assistants and developers in authoring, validating, packaging, and publishing add-ons for the **Praxis** desktop application.

Praxis add-ons are distributed as standard npm packages published to **GitHub Packages** (or any npm-compatible registry).

---

## 1. Add-on Architecture Overview

Praxis supports four distinct add-on kinds (`AddonKind`):
1. **`theme`**: Color palette definitions (`light` or `dark` mode) with optional terminal palette.
2. **`surface-pack`**: Material and tactile layers (grain, paper texture, glass, vignette, watermark motifs).
3. **`agent`**: Specialized AI agent runners conforming to the Agent Client Protocol (ACP).
4. **`workflow-template`**: Reusable delivery pipeline DAGs composed of agent tasks, automated checks, gates, and approval stages.

### Package Structure on Disk
Every add-on package follows this exact file structure:

```text
my-addon/
├── package.json          # Standard npm package.json with top-level `praxis` manifest
└── addon/                # Payload directory unpacked into Praxis userData/addons/<kind>/<id>/
    ├── theme.json        # If kind === 'theme'
    ├── pack.json         # If kind === 'surface-pack'
    ├── agent.json        # If kind === 'agent'
    └── template.json     # If kind === 'workflow-template'
```

---

## 2. The `package.json` Manifest Contract

The root `package.json` contains standard npm fields plus a required `praxis` object validated by `validateAddonManifest`:

```json
{
  "name": "@<owner>/praxis-addon-<id>",
  "version": "1.0.0",
  "description": "Short human description of the add-on.",
  "author": "<owner>",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/<owner>/praxis.git"
  },
  "praxis": {
    "schemaVersion": 1,
    "kind": "workflow-template",
    "id": "my-template-id",
    "name": "My Template Name",
    "summary": "Brief 1-sentence summary shown in the marketplace catalog.",
    "author": "<owner>",
    "contentVersion": "1.0.0",
    "minAppVersion": "0.3.0",
    "homepage": "https://github.com/<owner>/praxis",
    "display": {
      "mode": "dark",
      "preview": {
        "canvas": "#1e1e1e",
        "panel": "#252526",
        "accent": "#007acc"
      }
    }
  }
}
```

### Manifest Field Rules
- `schemaVersion`: Must be literal integer `1`.
- `kind`: Exactly one of `'theme' | 'surface-pack' | 'agent' | 'workflow-template'`.
- `id`: Lowercase kebab-case matching `^[a-z0-9][a-z0-9-]{0,63}$` (e.g. `full-sdlc-node`, `nord-aurora`).
- `name`: Required string, `1` to `80` characters.
- `summary`: Recommended string, concise description for search/browsing.
- `contentVersion`: Semver string (`MAJOR.MINOR.PATCH`).
- `minAppVersion`: Minimum compatible Praxis desktop version (e.g. `"0.3.0"`).
- `display`: Required for `theme` (must include `mode: 'light' | 'dark'` and `preview` color map); optional for `surface-pack`.

---

## 3. Payload Specifications by Kind

### 3.1. Workflow Template (`addon/template.json`)
The payload is a complete `WorkflowDefinition` object:

```json
{
  "schemaVersion": 1,
  "id": "full-sdlc-node",
  "name": "Full SDLC (Node.js)",
  "description": "12-stage governed pipeline with lint, typecheck, test, SAST, secrets, SCA, review, gates, and approval.",
  "scope": "global",
  "version": 1,
  "entryNodeId": "plan",
  "builtIn": false,
  "createdAt": "2026-09-12T00:00:00.000Z",
  "updatedAt": "2026-09-12T00:00:00.000Z",
  "nodes": [
    {
      "id": "plan",
      "name": "Plan",
      "type": "agent-task",
      "x": 0,
      "y": 100,
      "inputs": [],
      "agent": {
        "agentId": "praxis-planner",
        "scope": "global",
        "toolMode": "read-only"
      },
      "instructions": "Analyze requirements and prepare delivery plan.",
      "outputs": [{ "id": "plan-spec", "kind": "plan", "required": true }],
      "mutatesWorktree": false
    },
    {
      "id": "lint",
      "name": "ESLint",
      "type": "check",
      "x": 200,
      "y": 50,
      "inputs": ["plan-spec"],
      "command": "npx",
      "args": ["eslint", "."],
      "outputs": [{ "id": "lint-findings", "kind": "findings", "required": true, "adapter": "sarif" }]
    },
    {
      "id": "approve",
      "name": "Approve",
      "type": "approval",
      "x": 600,
      "y": 100,
      "inputs": [],
      "prompt": "Approve changes for release?",
      "requiredGates": ["qa", "security", "review"],
      "allowBypass": false,
      "gateThresholds": {
        "qa": [{ "type": "metric", "metric": "lineCoveragePct", "operator": ">=", "value": 80 }],
        "security": [{ "type": "severity", "severityLevel": "high", "maxCount": 0 }]
      }
    }
  ],
  "edges": [
    { "id": "e1", "from": "plan", "to": "lint", "on": "success", "required": true }
  ]
}
```

#### Node Types
- `agent-task`: Driven by an AI agent through Agent Client Protocol (`acp`).
- `check`: Deterministic shell command (`exit 0` = success). Outputs can specify `kind: 'findings'` with adapters (`sarif`, `junit`, `lcov`, `npm-audit`, `osv-scanner`). Can declare `observe: { enabled: true, provider: 'github-actions' }`.
- `join`: Converges parallel branches (`mode: 'all'` or `'all-required'`).
- `approval`: Human checkpoint requiring satisfied gates (`qa`, `security`, `review`).
- `deployment`: Deploys verified artifacts.

---

### 3.2. Theme (`addon/theme.json`)
Defines design system tokens for Praxis surfaces:

```json
{
  "id": "nord-aurora",
  "name": "Nord Aurora",
  "mode": "dark",
  "description": "A cool, arctic palette based on Nord.",
  "preview": {
    "canvas": "#2e3440",
    "panel": "#3b4252",
    "raised": "#434c5e",
    "border": "#4c566a",
    "text": "#eceff4",
    "muted": "#d8dee9",
    "accent": "#88c0d0",
    "success": "#a3be8c",
    "warning": "#ebcb8b",
    "danger": "#bf616a"
  },
  "terminal": {
    "black": "#3b4252",
    "red": "#bf616a",
    "green": "#a3be8c",
    "yellow": "#ebcb8b",
    "blue": "#81a1c1",
    "magenta": "#b48ead",
    "cyan": "#88c0d0",
    "white": "#e5e9f0"
  }
}
```

---

### 3.3. Surface Pack (`addon/pack.json`)
Defines tactile material layers (paper grain, frosted glass, slate):

```json
{
  "id": "faded-linen",
  "name": "Faded Linen",
  "description": "Soft textured linen grain.",
  "basePackId": "parchment",
  "tokens": {
    "--surface-texture-opacity": "0.45",
    "--surface-panel-opacity": "0.92"
  }
}
```

---

### 3.4. Agent (`addon/agent.json`)
Defines an autonomous AI agent package:

```json
{
  "id": "custom-reviewer",
  "name": "Custom Reviewer",
  "type": "acp",
  "activation": "manual",
  "description": "Specialized code review agent.",
  "command": "node",
  "args": ["dist/agent.js"],
  "capabilities": {
    "supportsTools": true
  }
}
```

*Note:* Agent add-ons install **disabled** by default for security. Users must grant trust in Settings → Agent Runtime before an agent will execute code.

---

## 4. Packaging and Publishing

### 4.1. Automated Build via CLI Scripts
Praxis includes built-in scripts to package and publish add-ons:

```bash
# Build the 4 Full SDLC workflow template add-ons
node scripts/build-addons.mjs

# Validate add-ons without publishing (dry run)
node scripts/publish-addon.mjs --dry-run --all

# Publish a specific add-on to GitHub Packages
GITHUB_TOKEN="ghp_xxx" node scripts/publish-addon.mjs addons/workflows/full-sdlc-node

# Publish all built workflow add-ons
GITHUB_TOKEN="ghp_xxx" node scripts/publish-addon.mjs --all
```

### 4.2. Tarball Construction
Tarballs must be gzipped `.tgz` archives where all contents live under the `package/` top-level directory:
- `package/package.json`
- `package/addon/<payload>`

Integrity is validated using standard SRI hashes:
```bash
shasum -b -a 512 dist/addons/praxis-addon-full-sdlc-node-1.0.0.tgz | awk '{print $1}' | xxd -r -p | base64
```

### 4.3. GitHub Packages Requirements
- Owner: Must match repository organization/user (e.g. `davidacres`).
- Package Prefix: Usually `@owner/praxis-addon-<id>`.
- Authentication: GitHub Personal Access Token (PAT) with `write:packages` and `read:packages` scopes.
- Registry URL: `https://npm.pkg.github.com`.
