# Mobile platform shell

Reserved for native platform integration and host-connection adapters: iOS/Android lifecycle, secure keys, camera pairing, local discovery, system-browser sign-in and optional notifications.

This follows desktop main/ ownership boundaries but is not an Electron application. The packaging decision and runnable scaffold belong to FX-BE-080 in [the plan map](../docs/PLAN_MAP.md). No package manifest or placeholder executable is added before that decision. Agent processes, repositories and provider credentials stay on the desktop host.
