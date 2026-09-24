# Agent notes: `apps/praxis-mobile`

Area-specific guidance, moved out of the root [AGENTS.md](../../AGENTS.md).
The root file still holds the rules that apply to every change; read it too.

## Real iPhone deployment guardrail

A phone build must be **Release** (Debug expects Metro and looks like a blank app
on a phone). The full procedure and checks live in the `mobile-device-testing`
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
