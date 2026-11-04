# FX-BE-184 retained verification evidence

Inspected on 2026-11-04 during iteration 3. These are retained execution records from the earlier implementation run, not new executions. The release gate remains open. Command exit codes come from the runner summary; output excerpts below retain counts and failures. Raw logs remain in `/tmp/fx184` and may expire.

## Runner summary

```text
=== build-core: npm run build:core (12:22:51)
=== build-core exit=0 (12:22:52)
=== test-core: npm run test:core (12:22:52)
=== test-core exit=0 (12:23:03)
=== check-types: npm run check-types (12:23:03)
=== check-types exit=0 (12:23:06)
=== build-renderer: npm run build:renderer (12:23:06)
=== build-renderer exit=0 (12:23:08)
=== copy-renderer: npm run desktop:copy-renderer (12:23:08)
=== copy-renderer exit=0 (12:23:08)
=== build-desktop: npm run build:desktop (12:23:08)
=== build-desktop exit=0 (12:23:09)
=== test-desktop-git: npm run test:desktop:git (12:23:09)
=== test-desktop-git exit=0 (12:23:14)
=== test-renderer: npm run test:renderer (12:23:14)
=== test-renderer exit=0 (12:23:21)
=== focused-e2e: npm run test:e2e --workspace=@praxis/desktop-main -- e2e/assistant.spec.ts e2e/quickSession.spec.ts e2e/durableTeamChat.spec.ts e2e/standaloneConversations.spec.ts --project=functional --reporter=line (12:23:21)
=== focused-e2e exit=1 (12:25:58)
=== test-praxis-contracts: npm run test:praxis-contracts (12:25:58)
=== test-praxis-contracts exit=0 (12:25:59)
=== live exit=0
=== test-desktop: npm run test:desktop -- --reporter=line (12:26:16)
=== test-desktop exit=1 (12:45:36)
=== test-desktop-themes: npm run test:desktop:themes -- --reporter=line (12:45:36)
=== test-desktop-themes exit=0 (12:47:31)
DONE
```

## build-core.log

Source: `/tmp/fx184/build-core.log`. SHA256: `cd56a916bef6bcfa46056cd7eb7e3d7db2da5e01bad5aa8d46e5f97509b682c4`.

```text
> build:core
> npm run compile --workspace=@praxis/core


> @praxis/core@0.0.0 compile
> tsc -p .
```

## build-desktop.log

Source: `/tmp/fx184/build-desktop.log`. SHA256: `5abe6a66c2837265a4c94e9cdcd4e233744bedc3f05912426fa48f914300b58c`.

```text
> build:desktop
> npm run compile --workspace=@praxis/desktop-main


> @praxis/desktop-main@0.6.1 compile
> npm run check-ipc-senders && tsc -p .


> @praxis/desktop-main@0.6.1 check-ipc-senders
> node scripts/checkTrustedIpc.cjs
```

## build-renderer.log

Source: `/tmp/fx184/build-renderer.log`. SHA256: `09148fa8170793ab813e1fae94c6c518d1d154017d47a1eaa9dd0edc4817e0cf`.

```text
computing gzip size...
dist/index.html                                 0.78 kB │ gzip:   0.46 kB
dist/assets/frost@2x-BY8lRGg9.webp              4.12 kB
dist/assets/paper-fibre@2x-BIvs55QL.webp       10.61 kB
dist/assets/brushed-metal@2x-B_g8aL5B.webp     12.61 kB
dist/assets/film-grain-fOJipSoX.webp           19.99 kB
dist/assets/film-grain@2x-BSQwnop-.webp        77.93 kB
dist/assets/index-DSSY1W3A.css                843.29 kB │ gzip: 135.23 kB
dist/assets/index-DCj7IIGF.js               2,413.77 kB │ gzip: 656.09 kB

✓ built in 338ms
[plugin builtin:vite-reporter]
(!) Some chunks are larger than 500 kB after minification. Consider:
- Using dynamic import() to code-split the application
- Use build.rolldownOptions.output.codeSplitting to improve chunking: https://rolldown.rs/reference/OutputOptions.codeSplitting
- Adjust chunk size limit for this warning via build.chunkSizeWarningLimit.
```

## check-types.log

Source: `/tmp/fx184/check-types.log`. SHA256: `51d94c0337861376a40c3eca26d153776547311e23045a250b47457242cc2a2d`.

```text


> @praxis/desktop-renderer@0.0.0 check-core-imports
> node scripts/checkCoreImports.cjs


> @praxis/core@0.0.0 check-types
> tsc --noEmit -p .


> @praxis/mobile-protocol@0.0.0 check-types
> tsc --noEmit -p .


> @praxis/mobile-relay@0.0.0 check-types
> tsc --noEmit -p .
```

## copy-renderer.log

Source: `/tmp/fx184/copy-renderer.log`. SHA256: `3ef90c5599c6bd417b7c1ab98c228943152f19e4322ae5f28e2afeedc07eaa16`.

```text
> desktop:copy-renderer
> npm run copy-renderer --workspace=@praxis/desktop-main


> @praxis/desktop-main@0.6.1 copy-renderer
> node scripts/copy-renderer.cjs

copied /Users/daveacres/dev/tools/praxis/.worktrees/WF-C10627E5-governed-delivery-fx-be-184-durable-team-chat-re/apps/praxis-desktop/renderer/dist -> /Users/daveacres/dev/tools/praxis/.worktrees/WF-C10627E5-governed-delivery-fx-be-184-durable-team-chat-re/apps/praxis-desktop/main/renderer
```

## focused-e2e.log

Source: `/tmp/fx184/focused-e2e.log`. SHA256: `8e0632c57b581090ee2954388f1a4720b3e0e4091f290dfd1f5c1c66b47476aa`.

```text
[40/45] [functional] › e2e/assistant.spec.ts:747:5 › every persona renders with its own distinct colour and a readable badge
[41/45] [functional] › e2e/assistant.spec.ts:764:5 › the assistant's controls show a focus ring and carry tooltips
[42/45] [functional] › e2e/assistant.spec.ts:828:5 › the assistant stays readable on every theme and surface pack
[43/45] [functional] › e2e/assistant.spec.ts:919:5 › the composer grows with its text up to the shared cap, then scrolls
[44/45] [functional] › e2e/assistant.spec.ts:940:5 › durable no-tools API turns retain bounded history and usage without allocating agent sessions
[45/45] [functional] › e2e/assistant.spec.ts:975:5 › durable tool members reuse two runtime sessions for four attempts and isolate another chat
  1 failed
    [functional] › e2e/assistant.spec.ts:106:5 › floating assistant drags by its header and resizes from its corner
  44 passed (2.6m)
npm error Lifecycle script `test:e2e` failed with error:
npm error code 1
npm error path /Users/daveacres/dev/tools/praxis/.worktrees/WF-C10627E5-governed-delivery-fx-be-184-durable-team-chat-re/apps/praxis-desktop/main
npm error workspace @praxis/desktop-main@0.6.1
npm error location /Users/daveacres/dev/tools/praxis/.worktrees/WF-C10627E5-governed-delivery-fx-be-184-durable-team-chat-re/apps/praxis-desktop/main
npm error command failed
npm error command sh -c npm run copy-renderer && npm run compile && npx playwright test e2e/assistant.spec.ts e2e/quickSession.spec.ts e2e/durableTeamChat.spec.ts e2e/standaloneConversations.spec.ts --project=functional --reporter=line
```

## live.log

Source: `/tmp/fx184/live.log`. SHA256: `7f9a85aa2c6047f840ddffacea7a9984dece91f928d71c2166e743b057c80c44`.

```text
Running 2 tests using 1 worker

[1/2] [live-agent] › e2e/durableTeamChat.live.spec.ts:96:5 › real CLI member continues a durable team chat across an app restart
[2/2] [live-agent] › e2e/durableTeamChat.live.spec.ts:109:5 › real API member continues a durable team chat across an app restart
  1 skipped
  1 passed (16.3s)
```

## test-core.log

Source: `/tmp/fx184/test-core.log`. SHA256: `a503df26d7054903cd47accde3534c32c257d7d88a5d8150aa8d44c824b8f5dd`.

```text
✔ a folder inside the workspace file`s tree is stored relative to it (1.019792ms)
✔ a folder outside the tree stays absolute rather than being rewritten (0.195834ms)
✔ stored paths use POSIX separators so a file written on one OS opens on another (0.134375ms)
✔ a relative path resolves against wherever the file now lives (0.125125ms)
✔ an absolute stored path passes through untouched (0.063875ms)
✔ round-tripping an in-tree folder from a different absolute root still resolves (0.072875ms)
✔ empty and already-relative inputs are left alone (0.057084ms)
✔ isPortableFolderPath reports whether a stored path will travel (0.053875ms)
ℹ tests 1941
ℹ suites 9
ℹ pass 1939
ℹ fail 0
ℹ cancelled 0
ℹ skipped 2
ℹ todo 0
ℹ duration_ms 9994.012625
```

## test-desktop-git.log

Source: `/tmp/fx184/test-desktop-git.log`. SHA256: `4814b8680fd1c26ab7f40d6fb1f58b0b16e2214a8371e4b0069208789ec39211`.

```text
✔ safeSend: returns false when mainFrame getter throws disposed error (0.270792ms)
✔ safeSend: returns true and calls send when window and frame are intact (0.965875ms)
✔ broadcastToWindows: dispatches to all live windows and skips disposed ones (0.118334ms)
✔ isBoundsVisibleOnAnyDisplay: validates bounds within display work area (0.767959ms)
✔ loadWindowState: returns default bounds when file does not exist (2.061166ms)
✔ loadWindowState: restores saved bounds when visible on display (2.292083ms)
✔ loadWindowState: drops position if saved coordinates are off-screen (2.172959ms)
✔ saveWindowStateSync: persists bounds from BrowserWindow mock (3.909208ms)
ℹ tests 139
ℹ suites 0
ℹ pass 139
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 4116.527792
```

## test-desktop-themes.log

Source: `/tmp/fx184/test-desktop-themes.log`. SHA256: `c1d0b86b0edf67e256d902ee8efb1521d7f193bb150155be336f817ac3fffe81`.

```text
[33/47] [themes] › e2e/surfacePacks.spec.ts:410:5 › Repeat is what turns a one-shot reveal into a loop
[34/47] [themes] › e2e/surfacePacks.spec.ts:423:5 › layer-family styles drive CSS and leave the motif SVG untouched
[35/47] [themes] › e2e/surfacePacks.spec.ts:448:5 › an animated motif never raises the declared strength past the contrast ceiling
[36/47] [themes] › e2e/surfacePacks.spec.ts:464:5 › the master switch stops every motif animation, whatever the style says
[37/47] [themes] › e2e/surfacePacks.spec.ts:481:5 › the motif rides over any pack, and animation rides over any motif
[38/47] [themes] › e2e/surfacePacks.spec.ts:498:5 › switches surface pack, composing over the current theme, and persists it
[39/47] [themes] › e2e/surfacePacks.spec.ts:512:5 › the Intensity dial scales the texture and is disabled for Flat
[40/47] [themes] › e2e/surfacePacks.spec.ts:532:5 › contrast guard: flat is inert and every pack keeps a readable panel ground
[41/47] [themes] › e2e/surfacePacks.spec.ts:568:5 › contrast guard: no pack pushes its watermark past a readable ceiling
[42/47] [themes] › e2e/surfacePacks.spec.ts:601:5 › Aurora Glass frosts the sidebar and the translucency dial collapses it
[43/47] [themes] › e2e/surfacePacks.spec.ts:645:5 › Noir is offered under a dark theme and hidden under a light one
[44/47] [themes] › e2e/surfacePacks.spec.ts:662:5 › a custom surface pack can be created, applied, and survives a reload
[45/47] [themes] › e2e/surfacePacks.spec.ts:681:5 › a user can swap the material by picking a pattern — no code, no new CSS
[46/47] [themes] › e2e/surfacePacks.spec.ts:706:5 › the Window-blur toggle is present on a vibrancy-capable OS and persists
[47/47] [themes] › e2e/surfacePacks.spec.ts:721:5 › the Texture toggle gates the grain layer without changing the pack
  47 passed (1.9m)
```

## test-desktop.log

Source: `/tmp/fx184/test-desktop.log`. SHA256: `fa722b68fc91d05cd40e10cf79de1c67b7b8e499fe2d8592cedbd2503789bfbc`.

```text
[762/763] [functional] › e2e/workflowRunWorkspace.spec.ts:753:5 › auto-approve does not widen a stage: a read-only stage still cannot write
[763/763] [functional] › e2e/workflowRunWorkspace.spec.ts:776:5 › a terminal run can be archived, removing it from the sidebar and listing it in the workflow runs browser
  4 failed
    [functional] › e2e/agentHub.spec.ts:88:5 › Agent Runtime record buttons follow the app theme ───
    [functional] › e2e/notesPersistence.spec.ts:244:5 › ordinary note actions never call a provider or create a session
    [functional] › e2e/scheduledRunEndToEnd.spec.ts:53:55 › a mixed serial and parallel schedule starts at its time, runs to completion without anyone, and moves its folder tickets across the board
    [functional] › e2e/sessionShelf.spec.ts:262:5 › only the revealed spine glows when moving across all five sessions
  14 skipped
  745 passed (19.3m)
npm error Lifecycle script `test:e2e` failed with error:
npm error code 1
npm error path /Users/daveacres/dev/tools/praxis/.worktrees/WF-C10627E5-governed-delivery-fx-be-184-durable-team-chat-re/apps/praxis-desktop/main
npm error workspace @praxis/desktop-main@0.6.1
npm error location /Users/daveacres/dev/tools/praxis/.worktrees/WF-C10627E5-governed-delivery-fx-be-184-durable-team-chat-re/apps/praxis-desktop/main
npm error command failed
npm error command sh -c npm run copy-renderer && npm run compile && npx playwright test --project=functional --reporter=line
```

## test-praxis-contracts.log

Source: `/tmp/fx184/test-praxis-contracts.log`. SHA256: `425d85abd6d81093e57e9063bd2de0650eda7c03cae1493f266e416d4802790c`.

```text
> test:praxis-contracts
> node apps/praxis-desktop/main/scripts/praxis-test-catalog.cjs

Praxis Tests: 800 Playwright tests catalogued and linked.
```

## test-renderer.log

Source: `/tmp/fx184/test-renderer.log`. SHA256: `390834a83cfe267cd0e43107d522d8aa9eab8ec0496b8b4cabb5bbac53dcfeb4`.

```text
✔ autoDetectParallelSteps handles linear dependency chains by keeping single-ticket steps (0.087834ms)
✔ autoDetectParallelSteps handles empty or single ticket lists (0.069083ms)
(node:27483) [DEP0205] DeprecationWarning: `module.register()` is deprecated. Use `module.registerHooks()` instead.
(Use `node --trace-deprecation ...` to show where the warning was created)
✔ steps number from 1 and a ticket sharing the previous step keeps its number (1.195209ms)
✔ a bead says what its ticket is doing; the ticket a pause is about needs you even before it starts (0.086458ms)
✔ a running task shows time since its reported start; a finished one its duration; nothing else is invented (0.119458ms)
✔ keys, tokens, money and durations read short (11.353417ms)
ℹ tests 33
ℹ suites 0
ℹ pass 33
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 6192.021542
```

## Real CLI context receipts

The retained record below includes the actual attempt IDs, epochs, delivered message IDs and reply after restart. Its temporary working directory is a test profile, not a working-tree write target.

```json
{
  "check": "cli",
  "codename": "heron-cogr7",
  "conversationId": "chat-mw23bq17-louw2",
  "recordedAt": "2026-11-04T12:26:16.066Z",
  "runtimeOptions": {
    "provider": "claude-code-cli",
    "toolMode": "read-only",
    "permissionMode": "manual",
    "workingDirectory": "/var/folders/8m/f0xl4j_52gz8kl8wk6lvsdxr0000gn/T/praxis-live-team-chat-jMEXGa"
  },
  "bindings": [
    {
      "id": "id-mw23bq2q-jyvm1f",
      "providerRuntime": "claude-code-cli:516354c3d15d9bcce27641019c89e4277f3519c899d18e10acd55f07f43842b7",
      "status": "invalid",
      "providerSessionId": "80c01ae3-d0f8-470b-811e-fc4f9b14e1d8",
      "delivered": 1
    },
    {
      "id": "id-mw23bt8g-kq4x3x",
      "providerRuntime": "claude-code-cli:516354c3d15d9bcce27641019c89e4277f3519c899d18e10acd55f07f43842b7",
      "status": "invalid",
      "providerSessionId": "c15bc97d-3414-4a79-9282-d63787add941",
      "delivered": 3
    },
    {
      "id": "id-mw23bxs0-fdx4wo",
      "providerRuntime": "claude-code-cli:516354c3d15d9bcce27641019c89e4277f3519c899d18e10acd55f07f43842b7",
      "status": "valid",
      "providerSessionId": "879e1b0e-48e5-4d0b-a9f5-b2e304b9008e",
      "delivered": 5
    }
  ],
  "attempts": [
    {
      "turnId": "id-mw23bq23-69rxcg",
      "attemptId": "id-mw23bq2p-f9p14t",
      "state": "completed",
      "coordinatorEpoch": "id-mw23bq1q-fnpg6s",
      "bindingId": "id-mw23bq2q-jyvm1f",
      "providerSessionId": "80c01ae3-d0f8-470b-811e-fc4f9b14e1d8",
      "contextReceipt": {
        "digest": "9bd6d5431ac143edb71f4c2aabfcc6674b62f0ee57ec71ad3bd6c72c0d85c11e",
        "messageIds": [
          "id-mw23bq23-qek6ok"
        ],
        "bindingId": "id-mw23bq2q-jyvm1f",
        "instructionVersion": "1",
        "budget": {
          "limit": 32768,
          "reserved": 12288,
          "estimated": 692,
          "method": "utf8-bytes-upper-bound"
        }
      },
      "usage": {
        "inputTokens": 2,
        "outputTokens": 37,
        "totalTokens": 20932,
        "cachedInputTokens": 9185
      }
    },
    {
      "turnId": "id-mw23bt7q-uggxja",
      "attemptId": "id-mw23bt8f-nr7hhw",
      "state": "completed",
      "coordinatorEpoch": "id-mw23bq1q-fnpg6s",
      "bindingId": "id-mw23bt8g-kq4x3x",
      "providerSessionId": "c15bc97d-3414-4a79-9282-d63787add941",
      "contextReceipt": {
        "digest": "37e35e898fd1f1fef6b4425c3db147da2a2863831e67313751c8ee467064aecf",
        "messageIds": [
          "id-mw23bq23-qek6ok",
          "id-mw23bsuo-v1nbgi",
          "id-mw23bt7q-h1cm27"
        ],
        "bindingId": "id-mw23bt8g-kq4x3x",
        "instructionVersion": "1",
        "budget": {
          "limit": 32768,
          "reserved": 12288,
          "estimated": 892,
          "method": "utf8-bytes-upper-bound"
        }
      },
      "usage": {
        "inputTokens": 2,
        "outputTokens": 57,
        "totalTokens": 23835,
        "cachedInputTokens": 9614
      }
    },
    {
      "turnId": "id-mw23bxqq-gggjy0",
      "attemptId": "id-mw23bxry-v24jjp",
      "state": "completed",
      "coordinatorEpoch": "id-mw23bw8z-2rylsf",
      "bindingId": "id-mw23bxs0-fdx4wo",
      "providerSessionId": "879e1b0e-48e5-4d0b-a9f5-b2e304b9008e",
      "contextReceipt": {
        "digest": "7e31c8a5c462dee548b379bca0ca52c61264b699cef0d9989b664254f99ade39",
        "messageIds": [
          "id-mw23bq23-qek6ok",
          "id-mw23bsuo-v1nbgi",
          "id-mw23bt7q-h1cm27",
          "id-mw23buwv-vpvk23",
          "id-mw23bxqq-zc9uga"
        ],
        "bindingId": "id-mw23bxs0-fdx4wo",
        "instructionVersion": "1",
        "budget": {
          "limit": 32768,
          "reserved": 12288,
          "estimated": 1204,
          "method": "utf8-bytes-upper-bound"
        }
      },
      "usage": {
        "inputTokens": 2,
        "outputTokens": 9,
        "totalTokens": 23910,
        "cachedInputTokens": 13796
      }
    }
  ],
  "replies": [
    "Noted: the release codename for this chat is **heron-cogr7**.",
    "A late rename can leave stale references to **heron-cogr7** in build scripts, artifact names, tags, and docs, which breaks pipelines or confuses people at release time.",
    "heron-cogr7"
  ]
}```

## Screenshot inventory

These images remain session artifacts and are not committed. Hashes identify the current retained captures, which may have been overwritten by later test reruns. They do not prove a hand-driven verification session.

| Artifact | Bytes | SHA256 |
| --- | --- | --- |

| `.praxis/session-artifacts/durable-team-chat-two-windows.png` | 459470 | `e86f66543c4f0bc11cf186a597c57aaf802428e89e785a06c74929d4fc2cca0b` |

| `.praxis/session-artifacts/durable-team-chat-queue.png` | 452171 | `1d89c8390ede4eb06815f747f2a909b7836bc7b6e6ca7d3052782eced3b0b313` |

| `.praxis/session-artifacts/fx-be-184-restart-interrupted.png` | 536289 | `04363347384b68f90ab7b50836f00886a333ab576b03111de088e5f8e9c9d6b9` |

| `.praxis/session-artifacts/fx-be-184-storage-failure.png` | 499991 | `52cce55ccf20fc3c369ea4ca8984fad02b114082f6d7020fac5714b3bd583035` |
