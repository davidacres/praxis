# Agent notes: `apps/praxis-mobile`

Area-specific guidance, moved out of the root [AGENTS.md](../../AGENTS.md).
The root file still holds the rules that apply to every change; read it too.

## Real iPhone deployment guardrail

A phone build must be **Release** (Debug expects Metro and looks like a blank app
on a phone). Deploy in one step using:
```bash
./scripts/deploy-iphone.sh
# or:
npm run mobile:deploy
```
The script runs with zero parameters: it auto-detects the connected device, builds
core packages, compiles in Release, verifies `main.jsbundle`, installs, and launches.

**Native module safety:** any optional or conditionally-linked native module
(such as `expo-local-authentication`) must never be eagerly required at module
evaluation time. Load native modules safely via dynamic getters with fallbacks
(e.g., `app/confirmIdentity.ts`), or unlinked native pods will cause an unhandled
runtime exception on boot and render a blank screen on the physical device.

The full procedure and checks live in the `mobile-device-testing`
skill (`addons/skills/mobile-device-testing/`) and
`apps/praxis-mobile/docs/ios-phone-deployment.md`; follow those.

## Mobile theme follows the desktop

The phone wears the paired desktop's theme. The desktop renderer resolves its
live CSS tokens to hex (`settings/mobileAppearancePublisher.ts`) and hands them
to main on every `tm-theme-changed`; `host.info` carries them as `appearance`
and a host-wide `host.appearance` event carries changes (the LAN server lets that
one event past a phone's project scope). On the phone, `app/theme.ts` holds the
live palette: build stylesheets with `themedStyles(() => StyleSheet.create(…))`
and read `theme.x` at render time, never capture a colour in a module-level
constant, or it won't follow the desktop. The phone imports only types from
`@praxis/core`, so its validation lives in `renderer/mobileTheme.ts`.
