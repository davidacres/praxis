# Session Lab

Capture a real two-turn Praxis conversation, then replay it through either the Rust ACP
host or the existing session chat pane. Provider and model are run inputs. The first
adapter records ACP CLI providers; HTTP/API capture requires a future transport adapter.
No recording happens during ordinary app use.

## Prerequisites

Install dependencies and build the current renderer and native binary:

```sh
npm run build:core
npm run build:renderer
npm run build:desktop
```

The default live capture needs an authenticated `codex-acp` executable on PATH. For another
ACP provider, supply its Praxis provider ID and executable. Model discovery must offer the
requested model, and the adapter must acknowledge model selection. The harness never
silently substitutes a model. `PRAXIS_TAURI_BIN` selects an alternate native binary and
`PRAXIS_E2E_PORT` selects a preview port when another checkout is using the default.

## Capture

```sh
node scripts/session-lab/run.mjs capture --model gpt-6.1-sol --headed
node scripts/session-lab/run.mjs capture --model ANOTHER_MODEL --effort high --headed
node scripts/session-lab/run.mjs capture --provider claude-code-cli --command claude-agent-acp --model MODEL_ID
```

Use `--out DIRECTORY` to choose the destination (it must not already contain a private
capture). Defaults are under ignored `output/playwright/session-lab/`. The command uses a
temporary Praxis profile, disposable Git workspace and known `fixture.txt`; it leaves
normal Praxis settings and repository files alone. The provider uses its existing login;
no credential files are copied or printed. ACP agents can read their normal user-level
instructions/configuration, so this is workspace isolation, not an OS sandbox.

The default scenario asks for a file read, short Markdown answer, list and code block;
then a follow-up that relies on the first turn. It asserts actual tool activity, two
completed turns and the known project code. It does not compare different models' wording.
`--scenario FILE` accepts JSON `{ "id": "…", "fixture": "…", "prompts": ["…", "…"] }`;
prompts must be distinct. Custom scenarios require a tool call and nonempty replies rather than the default code.
`--tool-mode read-only` and `--permission manual` select composer controls. `--args` accepts
an explicit JSON array of executable arguments. `--hold SECONDS` keeps the browser open
for inspection after the assertions.

A successful capture prints `SESSION_LAB_BUNDLE=…/recording.json`. It contains:

- Versioned manifest, scenario, requested settings, adapter/CLI versions and Git revision/dirty flag.
  Codex version is probed through the adapter; the unrelated executable found on npm PATH is labelled separately.
- Ordered actual renderer session-change payloads (including any deltas), initial state,
  two full checkpoints, user submissions, and relative monotonic reception times.
- Decoded, sanitised bidirectional ACP frames, process lifecycle and stderr.
- Model acknowledgement and provider-reported usage model IDs, kept distinct.

`private/` holds exact base64 byte chunks, including chunk boundaries, private session
updates and diagnostic manifests. Files have mode 0600 and its directory 0700. Version/help
probes are preserved as raw process captures but excluded from ACP parsing. Incomplete or
failed runs retain private diagnostics and are refused as replay fixtures. Preserve the
private directory for investigation; never commit or publish it.

The public JSON removes configured local roots, credentials in recognised fields/headers,
bearer/API-key strings and local service endpoints. It preserves token accounting. Review
new recordings before sharing: automatic sanitisation cannot recognise every secret in
arbitrary free-form tool output. Screenshots and Playwright traces can also contain local
paths; they remain ignored local evidence.

## Replay

```sh
node scripts/session-lab/run.mjs replay --bundle output/playwright/session-lab/RUN/recording.json --headed --hold 600
node scripts/session-lab/run.mjs provider --bundle output/playwright/session-lab/RUN/recording.json --headed
```

The pane route replays actual payloads through the renderer's normal session subscription.
Play, Pause, Step, Restart and speed controls are injected by the test harness, not shipped
in the production UI. It uses the conversation view used by the live composer. The clock
is fixed to each recorded event's time, keeping elapsed indicators meaningful. Workspace
inspection is closed because replay covers chat, not a live filesystem.

Playback pauses at the first completed turn. The composer then accepts exactly the recorded
follow-up; other submissions are refused. After the recorded follow-up it locks again.
The automated verification submits that follow-up and checks exact final events/reply text,
two rendered assistant bubbles, controls and screenshots. The `--hold` window starts at the
end; click Restart to explore from the beginning.

Provider replay uses a fixture executable that only reads the bundle and writes ACP JSON.
It cannot execute recorded tool commands or contact the model. Host-directed agent requests
are simulated (their recorded results are already reflected in subsequent frames), not
forwarded for execution. Request IDs and runtime session IDs are remapped; unexpected
methods, model choices or prompts fail. Prompt matching requires the recorded scenario's
user prompt, ignoring generated system context. `--speed` controls ACP playback speed
(default 4), preserving recorded inter-frame delays with a small scheduling floor so the
host consumes notifications before a turn's response settles it.

Permission interaction, cancellation, disconnects and crash/resume recovery are not covered
by the first scenario. A native `session/load` during the live follow-up is captured, but
that is not a separate restart/recovery test. Failed network streams are not claimed as
reproduced unless present in their own recording.

## Offline regression checks

The checked-in `codex-sol-two-turn.json.br` and `claude-sonnet-two-turn.json.br` fixtures
are sanitised real ACP captures compressed with Brotli. Snapshots repeat event history,
so their expanded JSON is substantially larger. Both `.json` and `.json.br` are supported.

```sh
npm run test:session-lab
npx playwright test -c apps/praxis-desktop/playwright.config.ts --project=functional sessionLab.spec.ts --workers=1
npx playwright test -c apps/praxis-desktop/playwright.config.ts --project=functional sessionPresentation.spec.ts --workers=1
```

The normal functional suite includes the replay and presentation tests; `npm test` also includes the format/player unit checks. Live recording is opt-in via
the `live-agent` project and the runner. The browser uses the real compiled renderer and
Rust host via the Tauri E2E bridge in Chromium; this does not prove WKWebView-specific behaviour.

The root aliases are `npm run session:capture -- …`, `npm run session:replay -- …`, and
`npm run session:replay-provider -- …`. The replay controls are test-only.

## Shared conversation presentation

Provider replay checks current normalization against the raw ACP frames. Pane replay
checks compatibility with the session snapshots recorded at capture time; it cannot
recover metadata an older host discarded.

| Detail | Shared display | Provider evidence |
| --- | --- | --- |
| Assistant messages | Preserve message IDs and boundaries | Explicit Codex `commentary` goes in Activity; `final_answer` is the answer. Claude's unclassified messages stay ordinary messages. |
| Work history | Activity, independently of optional reasoning | Tool names, refined titles, arguments, locations, status and available output survive sparse updates. Missing output is stated. |
| Reasoning | Existing reasoning view | Only supplied reasoning is shown; narration is not invented as reasoning. |
| Usage | Primary counters plus separately reported model rows | Cache reads and writes remain separate. Additional model usage is not silently added to the primary total. Provider categories may overlap. |
| Runtime | Requested settings beside reported ACP mode | Read-only requests and reported bypass/auto-review modes are separate facts; the fixture does not prove write enforcement. |

These captures exercise Codex and Claude through their ACP adapters. They do not capture
the native Codex CLI or Claude Code terminal UI. Native terminal presentation parity,
other models and other transports require their own evidence; the common display accepts
optional metadata without guessing missing provider fields.
