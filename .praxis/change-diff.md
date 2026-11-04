# change-diff — PRX-S111-182 recovery verification

This pass starts at `1bece54a`, which already contains the recovery repairs from `5843c95e`. It preserves those repairs and their gates, adds missing integration/decoder assertions, and tightens recovered completion to require the originating attempt epoch supplied by its caller.

## Review findings

1. **Prepared final result:** the recovered-result path accepts exact durable evidence without dispatch intent. The new coordinator test initializes twice from a prepared attempt and verifies one reply, preserved usage, absent dispatch intent and zero provider calls. The transition test additionally rejects the observing epoch as the completion epoch.
2. **Result after cancellation:** the existing abort-settlement branch persists the result and calls the same recovery importer. Existing cancellation coverage verifies a completed reply and retained settlement evidence. This branch was already repaired in the incoming revision and is preserved.
3. **Epoch schema:** `coordinatorEpoch` names the originating attempt; typed `observingEpoch` names the later observation. Existing startup round trips prove later observations survive repeated reloads. New decoder coverage independently rejects an empty observer and an observer incorrectly substituted for the originating epoch.
4. **Direct unknown retry:** the existing operation rejects with an explicit requirement to use `resolveAttempt`, reconciliation evidence and duplicate-risk acknowledgement. Existing tests prove rejection leaves the repository unchanged. No automatic replay was introduced.

## QA findings

The two reported cases (`scheduledRuns` parallel lanes and `sessionShelf` hover/drafts) both passed unchanged with one worker, 2/2. Their first restricted run failed before exercising product behavior because loopback/Electron access was denied; the permitted rerun passed. No assertion, timeout, test selection or product pointer behavior was weakened.

The full run exposed two synchronization gaps: the folder scheduler checked cleanliness before asynchronous outcome write-back had acknowledged completion, and the shelf dismissal test entered the sliding card before its open transform settled. The tests now wait for those existing observable boundaries, retaining the original clean-tree, pointer-leave and click-away assertions. No product UI or workflow behavior changed. Two additional full-run failures (workflow write-back visibility and a run-row delete click intercepted by its timestamp) are included in the isolated rerun without changing their assertions.

## Verification

- Core build passed; complete core suite: 1,913 passed, 2 skipped.
- All workspace type checks passed.
- Renderer build, renderer copy and desktop build passed.
- Main unit suite: 119 passed, including repository and adapter coverage.
- Final targeted transition/coordinator tests after the epoch-guard cleanup: 26 passed.
- Focused assistant, quick-session and permissions E2E: 32 passed.
- Full functional E2E: 731 passed, 14 skipped, 4 failed. The original two QA cases passed in this run. Final serial rerun of all failures and original QA cases: pending.
- Test catalog regenerated and checked: 784 tests catalogued and linked.
- Diff whitespace check passed.

The initial restricted core/main runs encountered socket/watch restrictions; unchanged permitted reruns passed. Runtime coverage uses scripted ACP/mock API providers; no real-provider calls were made. This pass changes backend recovery fencing and tests only. No manual visual verification or new screenshot artifacts were needed. Renderer cutover/recovery controls remain FX-BE-183; feature-wide release evidence remains FX-BE-184. No workflow definitions, dependencies or ticket statuses were changed.

## Patch artifact

[change-diff](../.praxis-change-diff.patch) contains this pass's source, test and contract-document diff against the starting revision. It excludes the report and patch itself.
