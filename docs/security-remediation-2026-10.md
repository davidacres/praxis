# Security remediation — October 2026

A summary of the security work done on 2026-10-23/24. It follows on from the
earlier remediation plan, PRX-F107 (`apps/praxis-desktop/docs/plans/features/feature-107-security-remediation-2026-09-24/`).

## Dependency vulnerabilities — commit `bbf1c438`

| Item | What was done |
|---|---|
| `ip-address` (moderate, GHSA-rxp7-6hxx-x8q5) | Pinned to 10.7.4 with a root `overrides` entry. This fixes a slow regex in IPv6 zone parsing. It came in through the MCP SDK, on a code path the app does not use. |
| `electron` (1 moderate, 2 low) | Upgraded to 43.8.3. The packaged app had been shipping 43.4.1 because `build.electronVersion` overrides the installed version, so all four version pins now agree. The native ABI (148) is unchanged, so `node-pty` still loads. |
| `LICENSING.md` | Regenerated to match the new lockfile. |

**Result:** `npm audit` reports 0 vulnerabilities.

## Secret scanning — commit `5d8ab0c3`

| Item | What was done |
|---|---|
| Leaked GitHub token found | A GitHub token was hardcoded in `e2e/marketplace.spec.ts` across six commits on the public `main` branch. It was already removed from the code, and GitHub now rejects it (401). |
| Test files scanned again | The gitleaks config skipped every `*.test.*` / `*.spec.*` file, which is why the token was never caught. Only the known fake test values are exempt now. |
| Full-history scan in CI | Added `check-secrets.sh --history` and a CI step for it, so secrets that were committed and later deleted are still caught. |
| Known old leaks recorded | `.gitleaksignore` lists the old leaks that are already dealt with (SEC-003 and the GitHub token), by fingerprint only. |
| False positives cleared | Narrow exemptions for the generated benchmark reports and gitignored runtime output. The CI secret scan, which had been failing since mid-October, now passes. |
| New npm scripts | `check-secrets:history` and `check-secrets:baseline`. |

## Outstanding

- Confirm the leaked GitHub token is revoked in the GitHub account settings, and rotate the token stored in `~/.npmrc` (outside the repo).
- `allowScripts` in the root `package.json` does nothing on the current npm version. It's a candidate for removal.
- The leaked token remains in git history. A history rewrite isn't planned because the token is already dead.
- Some gitleaks default rules miss certain fake token formats. That's an upstream gap.
