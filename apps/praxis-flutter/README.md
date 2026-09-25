# Praxis Mobile (Flutter)

A Flutter port of the Praxis phone app in `apps/praxis-mobile`: pairs with the
Praxis desktop over the encrypted Noise IK LAN transport and shows its
sessions, workflow runs, attention items and activity in the desktop's theme.

- What works and what is still unverified: [STATUS.md](STATUS.md)
- Layout and rules for changing it: [AGENTS.md](AGENTS.md)

```bash
flutter pub get
flutter test
node tool/stage_host.cjs   # a development desktop to pair with (see STATUS.md)
flutter run
```
