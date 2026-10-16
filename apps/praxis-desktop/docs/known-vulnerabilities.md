# Known accepted vulnerabilities

Advisories we have reviewed and accepted, with the reasoning. An alert appears
here when there is no patched version, the exposure is acceptable, and the
normal upgrade path would make things worse.

Reviewed: 2026-11-04.

## CVE-2026-97058 — `sprintf-js` (moderate)

| | |
|---|---|
| Alert | [Dependabot #52](https://github.com/davidacres/praxis/security/dependabot/52) |
| Package | `sprintf-js@1.1.3` |
| Range | `*` — all published versions |
| Patched | **None.** 1.1.3 is the latest release. |
| Introduced via | `electron-builder` → `app-builder-lib` → `@electron/get@3.1.0` → `global-agent@3.0.0` → `roarr@2.15.4` |
| Declared in | `apps/praxis-desktop/main/package.json` (`^26.15.3`) |
| Status | **Accepted — do not force-fix** |

`sprintf-js` does not validate precision specifiers before passing them to
`toFixed` / `toExponential` / `toPrecision`. An unvalidated specifier can throw
an uncaught `RangeError`, so attacker-controlled format strings are a denial of
service.

### Why we are not fixing it

1. **Build-time only.** The chain is reachable solely through
   `electron-builder`'s packaging step and lives entirely in
   `devDependencies`. `sprintf-js` is never bundled into the shipped desktop app
   or renderer, and never runs on a user's machine.
2. **No patched version exists.** Every published version is flagged, so there
   is no upgrade that resolves the advisory.
3. **The suggested fix is a downgrade.** `electron-builder` is already at the
   latest published release (26.15.3). `npm audit fix --force` proposes
   `electron-builder@26.5.0` — older packaging tooling, and the vulnerable
   `@electron/get` comes from `app-builder-lib`'s `^3.0.0` range, so the chain is
   very likely still present after the downgrade.
4. **Low trigger likelihood.** `roarr` uses `sprintf` for log formatting. The
   realistic attack needs control of format strings inside our own build.

### Note on the audit

`npm audit` reports 8 findings. All 8 are this single CVE seen through
different transitive paths. Do not read the count as 8 distinct problems.

`@electron/get@5.1.0` (pulled in by `electron@43.7.0`) is **not** vulnerable —
the affected range is `1.6.0 - 4.0.3`.

### If this ever needs revisiting

Re-check when `electron-builder` drops `app-builder-lib`'s `@electron/get@^3`
range, or when `sprintf-js` publishes a release. At that point the fix is a
normal dependency upgrade, not a forced one.

### Where to find the audit

```
npm audit
```

If a new alert arrives, check this file first and add an entry rather than
resolving the alert silently.