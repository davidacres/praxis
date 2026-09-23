# Mobile renderer

Reserved for the mobile feature UI: Work, Attention, Activity, host/project selection and the Chat/Progress/Changes session views. Follow the existing Praxis theme tokens and component conventions with a phone-specific layout.

The proposed React UI must consume browser-safe versioned contracts and assets; never import Electron, desktop source files or runtime values from Node-oriented core. Packaging is decided in FX-BE-080; this directory is not yet runnable. See [development guidance](../docs/development.md).


Navigation is intentionally work-focused: Work, Attention, and Activity are primary destinations; Chat, Progress, and Changes are selected from the navigation drawer for the active session rather than taking space in the session header.
