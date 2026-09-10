# Chat gadget proof

This proof adds a renderer-owned choice gadget to the Sessions chat. It deliberately does not replace or intercept Claude, Codex or Copilot functionality.

## What it proves

- The existing provider response remains visible.
- **Try gadget** opens a Praxis-owned choice surface.
- Selecting **Handoff** and pressing **Continue** records the choice locally in this proof.
- No second provider request is sent.
- The component has no provider, ACP or MCP imports, so it behaves identically for all providers.

Native provider modes, commands, tool calls and permission requests remain owned by their existing adapters and controls. The next production step is to replace the local callback with a scoped command-ledger action, without changing the renderer boundary.

## Run the test

From the repository root:

```bash
npm install
npm run compile --workspace=@praxis/core
npm run compile --workspace=@praxis/desktop-main
npx playwright test apps/praxis-desktop/main/e2e/aiSessions.spec.ts -g "provider-neutral Praxis choice gadget"
```

The test captures `output/playwright/chat-gadget-choice-selected.png`.

## Manual test

1. Start Praxis normally and open **Sessions**.
2. Create or select a completed AI session.
3. Confirm the provider response is visible.
4. Click **Try gadget** below the conversation.
5. Select **Handoff**, then click **Continue**.
6. Confirm **Choice recorded** and **Selected: Handoff**.
7. Send a normal follow-up to confirm the provider composer still works.
8. Repeat with Claude, Codex and Copilot sessions.

Expected visual reference: [chat gadget expected screenshot](screenshots/chat-gadget-choice-expected.svg).
