# Mobile platform shell

Reserved for native platform integration and host-connection adapters: iOS/Android lifecycle, secure keys, camera pairing, local discovery, system-browser sign-in and optional notifications.

This follows desktop main/ ownership boundaries but is not an Electron application. The native packaging decision (iOS/Android shell, real secure storage, camera, discovery) belongs to FX-BE-080 in [the plan map](../docs/PLAN_MAP.md). Agent processes, repositories and provider credentials stay on the desktop host.

## Development fixture

`mobileHostFixture.ts` + `mobileLoopbackServer.ts` stand up a deterministic
in-process host that satisfies the real core mobile-host contracts
(`handleMobileRead`, `handleMobileCommand`, `InMemoryMobileCommandLedger`) over
a loopback TCP socket. `mobileJourney.test.ts` drives
pair → connect → continue → approve → reconnect + replay against it, and
`npm run mobile:fixture` (root) runs the same journey as a printed walkthrough.
It replaces neither the real desktop binding (FX-BE-081/082, which wires these
contracts to `aiSessionManager` / `workflowOrchestrator` / `workflowGates`) nor
the real encrypted LAN transport (FX-BE-077).
