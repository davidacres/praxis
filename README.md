<h1 align="center">
  <img src="docs/assets/praxis-icon.png" alt="Praxis" width="64" valign="middle" /> Praxis
</h1>

<p align="center">
  <a href="https://github.com/davidacres/praxis/stargazers"><img src="https://img.shields.io/github/stars/davidacres/praxis?style=flat&amp;label=%E2%98%85&amp;color=08C" alt="GitHub stars" /></a>
  <a href="https://github.com/davidacres/praxis/releases"><img src="https://img.shields.io/github/downloads/davidacres/praxis/total?style=flat&amp;color=08C" alt="Total downloads across all releases" /></a>
  <img src="https://img.shields.io/badge/license-MIT-08C?style=flat" alt="License: MIT" />
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-4493F8?style=flat-square" alt="Supported platforms: macOS, Windows, and Linux" />
</p>

<p align="center">

<h1>This is a preview, if you would like to contribute or have any ideas, suggestions then please contact me in the discussion board.</h1>
  
  <strong>The workspace where boards, AI agents and delivery meet.</strong><br/>
  Plan on a board, hand a ticket to an agent, review the diff, ship it — on your desktop, and from your phone.
</p>

<h3 align="center"><a href="https://github.com/davidacres/praxis/releases/latest"><ins>Download Praxis</ins></a></h3>

<p align="center">
  <em>Click any screenshot to open the full high-resolution image in a new tab without navigating away from the page.</em>
</p>

### 💬 Sessions &nbsp;·&nbsp; Every Agent Conversation, One Place

Run Claude Code, Codex, Gemini CLI, GitHub Copilot or any ACP agent side by side. Each session keeps its own history, task list, cost and token meter, git branch and changed files — so you can start three before lunch and know exactly where each one stands.

<p align="center">
  <a href="https://raw.githubusercontent.com/davidacres/praxis/main/docs/assets/readme/sessions-dark.png" target="_blank" rel="noopener noreferrer">
    <img src="docs/assets/readme/sessions-dark.png" alt="Praxis session view (dark theme) — a streamed agent reply with code and a table, the session list on the left and the changed files with Commit and Discard on the right" width="960" />
  </a>
  <br/>
  <em>Sessions: the conversation in the middle, the session list on the left, and what the agent changed — with Commit and Discard — on the right. (Click to open full size)</em>
</p>

<br/>

### 🎯 Focus Mode &nbsp;·&nbsp; Just the Conversation

One click on the title bar's focus button (or **Toggle focus mode** in the command palette) hides both sidebars and the bottom panel, and the conversation takes the whole window. Your other sessions don't disappear: they collapse into a slim **session shelf** along the edge, each spine drawing its state — working, waiting for approval, waiting for you, done or failed. Hover or tab onto a spine for a card that answers an approval or follows up in place. Toggle again and your previous layout comes back exactly as you left it.

<p align="center">
  <a href="https://raw.githubusercontent.com/davidacres/praxis/main/docs/assets/readme/focus-mode-dark.png" target="_blank" rel="noopener noreferrer">
    <img src="docs/assets/readme/focus-mode-dark.png" alt="Praxis in focus mode — the conversation fills the window with a slim session shelf down the left edge" width="960" />
  </a>
  <br/>
  <em>Focus mode: the chrome steps back, the session shelf stays on the edge. (Click to open full size)</em>
</p>

<br/>

### ⏰ Scheduled Runs &nbsp;·&nbsp; Queue Tickets, Walk Away

Pick tickets from a project, drag them into a run order, choose a start time, and let Praxis work through them while you're away. A run starts at its time while Praxis is open, works its tickets one at a time (or side by side in parallel steps), and **pauses to ask you** at an approval gate, on a failure, or when a provider is nearly out of allowance — then hands over to the next provider with a context snapshot instead of stalling.

- **Lineup** — a seven-day timeline plus a *Needs you* list: a run that was due while Praxis was closed offers *Start now* or *Skip*; a paused run opens straight into its live view.
- **Composer** — a flow graph for the run order (drop a ticket onto another to share a step), a rehearsal of the order, a clock-face start time with timezone, and a policy for how each ticket's workflow runs.
- **Live view and report** — watch each ticket move through its stages as it runs, then read a report of what happened.

<p align="center">
  <a href="https://raw.githubusercontent.com/davidacres/praxis/main/docs/assets/readme/scheduled-runs-dark.png" target="_blank" rel="noopener noreferrer">
    <img src="docs/assets/readme/scheduled-runs-dark.png" alt="Praxis Scheduled runs — a seven-day timeline, a Needs you list and a running batch with per-ticket progress" width="960" />
  </a>
  <br/>
  <em>Scheduled runs: the week at a glance, what needs you, and a batch in flight. (Click to open full size)</em>
</p>

<br/>

<p align="center">
  <a href="https://raw.githubusercontent.com/davidacres/praxis/main/docs/assets/readme/scheduled-composer-dark.png" target="_blank" rel="noopener noreferrer">
    <img src="docs/assets/readme/scheduled-composer-dark.png" alt="Praxis scheduled run composer — a flow graph of tickets in run order, a clock-face start time and a run policy" width="960" />
  </a>
  <br/>
  <em>The composer: a flow graph for the run order, a start time, and a run policy. (Click to open full size)</em>
</p>

<br/>

## Features

<table>
<tr>
<td width="50%" valign="middle">

### Focus Mode &amp; the Session Shelf

Hide every panel with one click and keep the conversation; your other sessions stay one glance away on the shelf, each spine showing whether it's working, waiting on you, done or failed. Approve a tool request without leaving the thread.

</td>
<td width="50%">
  <a href="https://raw.githubusercontent.com/davidacres/praxis/main/docs/assets/readme/focus-mode-dark.png" target="_blank" rel="noopener noreferrer"><img src="docs/assets/readme/focus-mode-dark.png" alt="Praxis focus mode with the session shelf" width="100%" /></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Scheduled Runs

Queue tickets into a run order, set a start time, and Praxis works through them while you are away — pausing at approval gates and failures, and handing over to another provider when one runs low on allowance.

</td>
<td width="50%">
  <a href="https://raw.githubusercontent.com/davidacres/praxis/main/docs/assets/readme/scheduled-runs-dark.png" target="_blank" rel="noopener noreferrer"><img src="docs/assets/readme/scheduled-runs-dark.png" alt="Scheduled runs lineup" width="100%" /></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Boards for Any Backend

One board over Jira, GitLab, GitHub, a folder of markdown plans, or app storage. The workflow is data — author the stages once and every backend renders them natively.

[Docs →](docs/published-artifacts/project-details-and-board-surface.html)

</td>
<td width="50%">
  <a href="https://raw.githubusercontent.com/davidacres/praxis/main/docs/assets/readme/classic-mode-dark.png" target="_blank" rel="noopener noreferrer"><img src="docs/assets/readme/classic-mode-dark.png" alt="Praxis board with details panel" width="100%" /></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Hand a Ticket to an Agent

Turn a ticket into a session. The agent plans the work, asks before it uses a tool, and reports what it changed. Switch provider mid-session with a handover brief.

[Docs →](docs/published-artifacts/handing-a-ticket-to-an-agent.html)

</td>
<td width="50%">
  <a href="https://raw.githubusercontent.com/davidacres/praxis/main/docs/assets/readme/agent-session-dark.png" target="_blank" rel="noopener noreferrer"><img src="docs/assets/readme/agent-session-dark.png" alt="An AI session with summary and handover brief" width="100%" /></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Workspace Overview &amp; Provider Budgets

Monitor real-time AI spending, token consumption, and rate limits across all connected providers — Claude Code, OpenAI Codex, GitHub Copilot, Google Antigravity, and Cursor.

</td>
<td width="50%">
  <a href="https://raw.githubusercontent.com/davidacres/praxis/main/docs/assets/readme/overview-dark.png" target="_blank" rel="noopener noreferrer"><img src="docs/assets/readme/overview-dark.png" alt="Overview dashboard showing provider budgets and usage" width="100%" /></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Review Before You Commit

Every session records the files it touched. Read the diff beside the conversation, then commit or discard in one click. A native Git Graph covers staging, stashes and conflicts.

[Docs →](docs/published-artifacts/handing-a-ticket-to-an-agent.html)

</td>
<td width="50%">
  <a href="https://raw.githubusercontent.com/davidacres/praxis/main/docs/assets/readme/review-diffs.jpg" target="_blank" rel="noopener noreferrer"><img src="docs/assets/readme/review-diffs.jpg" alt="Session changes with a diff and commit button" width="100%" /></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Mobile Companion

Follow live sessions from your phone, read activity, and approve or deny the agent's permission requests from anywhere on your network — end-to-end encrypted, no cloud relay.

[Docs →](docs/published-artifacts/praxis-on-your-phone.html)

</td>
<td width="50%">
  <a href="https://raw.githubusercontent.com/davidacres/praxis/main/docs/assets/readme/mobile-companion.jpg" target="_blank" rel="noopener noreferrer"><img src="docs/assets/readme/mobile-companion.jpg" alt="Praxis desktop with the mobile companion app" width="100%" /></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Looks, Surfaces &amp; Composers

Make it yours. **Looks** bundle a whole appearance in one click — Noir, Blueprint, Graphite, Parchment, Aurora Glass and more. **Surface packs** add living textures behind the work (hex grids, blueprint lines, aurora gradients, grain). Pick a composer style — Classic, Ambient Canvas, Hairline or Command Strip — and bring your own with add-ons. Under the polish: a <kbd>Cmd</kbd>+<kbd>K</kbd> command palette that jumps to any session, ticket or action, and a keyboard focus ring on everything.

[Docs →](docs/published-artifacts/praxis-surface-packs.html)

</td>
<td width="50%">
  <a href="https://raw.githubusercontent.com/davidacres/praxis/main/docs/assets/readme/themes.jpg" target="_blank" rel="noopener noreferrer"><img src="docs/assets/readme/themes.jpg" alt="Praxis in four different looks" width="100%" /></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Agent Runtime &amp; Add-ons

Built-in Planner, Implementer, Reviewer, Security Analyst and Test Author agents, plus a marketplace for agents, skills, themes and workflow templates.

[Docs →](docs/published-artifacts/praxis-interface-system.html)

</td>
<td width="50%">
  <a href="https://raw.githubusercontent.com/davidacres/praxis/main/docs/assets/readme/agent-runtime.jpg" target="_blank" rel="noopener noreferrer"><img src="docs/assets/readme/agent-runtime.jpg" alt="Agent runtime settings" width="100%" /></a>
</td>
</tr>
</table>

**Also in the box:**

- **Native Git Graph** — Working, staged, commit and ref comparisons; inline, split and hunk views; file, hunk and line staging; stashes; three-way conflict resolution.
- **Workspaces** — Save a shareable set of projects and connections in a `.workspace.praxis.json` file and commit it. Secrets never travel with it.
- **Governed delivery workflows** — Stage-based runs with policies and bounded QA self-healing.
- **Folder-backed plans** — Point a project at a folder of markdown plans; the board is synthesised from the files.
- **Auto-update** — Signed builds check for and install updates in the background.

---

## Supported Agents

Works with the CLI agents you already use — sessions run against your own sign-in.

<p>
  <a href="https://docs.anthropic.com/claude/docs/claude-code"><kbd>Claude Code</kbd></a> &nbsp;
  <a href="https://github.com/openai/codex"><kbd>Codex</kbd></a> &nbsp;
  <a href="https://github.com/google-gemini/gemini-cli"><kbd>Gemini CLI</kbd></a> &nbsp;
  <a href="https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli"><kbd>GitHub Copilot</kbd></a> &nbsp;
  <kbd>+ any ACP agent</kbd>
</p>

---

## Install

### Quick Install

**macOS & Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/davidacres/praxis/main/scripts/install.sh | bash
```

The macOS builds are not notarized, so a `.dmg` downloaded in a browser is blocked by Gatekeeper. The install script above avoids that. If you used the `.dmg`, run `xattr -dr com.apple.quarantine /Applications/Praxis.app` once.

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/davidacres/praxis/main/scripts/install.ps1 | iex
```

### Desktop Downloads — macOS, Windows, Linux

- **[Download the latest release](https://github.com/davidacres/praxis/releases/latest)** — `.dmg` (macOS, Apple Silicon), `-setup.exe` (Windows), `.deb` (Linux, x86_64)

### Mobile Companion — iOS, Android

Pair with your desktop app (Settings → Mobile access → *Create pairing code*) to follow sessions and approve agent requests from your phone.

---

## Workspace / project / connection model

- **Workspace** — a saved, shareable context (`.workspace.praxis.json`) that groups
  project and connection references without copying their data. The sidebar has a
  workspace switcher; the tree is scoped to the active workspace. Exported files
  carry a `schemaVersion` and the app versions that wrote them, and contain
  references only — never connection secrets.
- **Project** — the unit of planned work, with one board. Work items live either
  in app storage or as markdown plans in the project's folder.
- **Connection** — an external/system backend: Jira MCP, Demo, a folder of
  markdown plans, or a GitLab delivery host.

Desktop Settings → Startup includes **Reopen last workspace**, which restores the
last valid workspace and durable view. With no valid open workspace, Praxis shows
a full-window Getting Started experience for creating or opening one. Projects are
always created inside the open workspace; the first project becomes its default.

## Git workspace

Praxis includes a native Git Graph and diff workspace backed by your Git
repository. It supports working/staged/commit/ref comparisons, Inline/Split/Hunk
views, file/hunk/selected-line staging, confirmed discard, branch and commit
actions, stash workflows, and three-way conflict resolution.

## Backend modes

| Mode | Value | Support |
| --- | --- | --- |
| Jira MCP | `jiracloud` | Primary hosted tracker. Backed by an external Jira MCP server. Board/issue operations, comments, transitions, linked-epic flows, delivery automation. |
| Demo | `demo` | Built-in sample data for development and demos. Off by default. |
| Folder | `folder` | Reads markdown feature plans from one or more folders on disk; can optionally create/update local issue files. |
| GitLab | `gitlab` | Connection and delivery/MR workflows; the issue/board model does not match Jira parity. |
| GitHub | `github` | Configuration surface only; no full board/issue backend yet. |

## Automatic updates

Packaged desktop builds check for updates automatically on launch and in the
background. When an update is ready, Praxis installs it on next launch or
immediately via the **Restart to update** button in the title bar. Update
preferences and manual checks are available under **Settings → Workspace → Updates**.

## Known limitations

- GitHub mode is not yet a full issue/board backend.
- GitLab support is strongest around delivery/MR workflows.
- Task Designer website-preview nodes only show sites that permit iframe embedding.
- Some automation flows depend on correct Jira/GitLab credentials, workflow
  settings, tracked boards, and repository setup.

## License

Praxis is MIT-licensed — see [`LICENSE`](LICENSE). [`LICENSING.md`](LICENSING.md) lists
the semantic search model's licence and every third-party package that ships.
