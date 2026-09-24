# Security Review (marketplace workflow)

Runs a security review of a project's whole codebase and writes a report. If you approve at the end, it also creates a remediation plan, ranked by priority, on the project's board.

## Using it

1. Install **Security Review** from Settings › Workflow templates, then add it to a project from **New workflow**.
2. Press **Run**. You don't need a ticket or a title.
3. When the run pauses on **Create remediation plan?**, open the **Security review** stage:
   - **Findings** are grouped by severity, each with file:line and a fix.
   - **Read report**, **Copy**, and **Save as Markdown…** give you the full report.
4. Choose **Approve** to create the plan on the project's board, or **Skip** if the report is all you need. The run page shows the plan's id (e.g. `AUDIT-F03`) with **Open on board**. On a folder-backed project the plan is written as markdown files in `docs/plans`. Each item's priority (P0–P3 as Highest…Low) and severity are set, and each vulnerability is filed as a Bug with its exploit steps, expected behaviour and actual behaviour filled in.

## Stages

| Stage | What it does |
| --- | --- |
| Repository inventory | Lists languages, dependency manifests, security-related config, and which scanners are installed |
| Attack surface | The AI maps entry points, trust boundaries, sensitive data and auth, and ranks where to look |
| SAST · Secrets · Dependencies | Semgrep, Gitleaks (working tree and git history), and OSV-Scanner. If OSV-Scanner is missing it falls back to `npm audit` / `pip-audit` / `dotnet list package --vulnerable`. A missing tool is logged as SKIPPED; a failing scanner never stops the review |
| Security review | The AI confirms or dismisses each scanner result, reviews the code by hand, and writes the report plus structured findings |
| Create remediation plan? | Optional: approve or skip |
| Remediation plan | The AI groups findings into P0–P3 work items; Praxis creates them on the board |

Every AI stage is read-only, and no stage changes your code.

## Scanners (optional, recommended)

```sh
brew install semgrep gitleaks osv-scanner
```

The review still runs without them, but without the tools' deterministic evidence. Semgrep runs with `--metrics=off`. The scanner stages use `sh`, so they need macOS or Linux.

## Changing it

Edit `scripts/build-security-review-addon.mjs`, run it, and commit it together with the regenerated `addon/template.json`. `packages/core/src/workflows/workflowAddonTemplates.test.ts` checks every workflow add-on; `apps/praxis-desktop/main/e2e/securityReviewRun.spec.ts` runs this workflow end to end in the app.
