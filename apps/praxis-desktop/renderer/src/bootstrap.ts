import { isTauri } from '@tauri-apps/api/core';

window.addEventListener('error', (event) => {
  console.error('[Praxis bootstrap error]', event.error || event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('[Praxis unhandled rejection]', event.reason);
});

try {
  // Always install the bridge in tauri.html so window.praxis is available before main.tsx runs
  if (isTauri() || typeof window !== 'undefined') {
    const { installTauriBridge } = await import('./host/installTauriBridge');
    await installTauriBridge();

    // Recover returning user state after Electron-to-Tauri migration
    try {
      const settings = await window.praxis.settings.get();
      if (settings?.appearance) {
        const activeLook = settings.appearance.looks?.find((l: { id: string }) => l.id === settings.appearance.activeLookId);
        const themeId = activeLook?.themeId ?? settings.appearance.themeId;
        const themeMode = activeLook?.themeMode ?? settings.appearance.themeMode;
        const surfacePackId = activeLook?.surfacePackId ?? settings.appearance.surfacePackId;
        const surface = activeLook?.surface ?? settings.appearance.surface;
        if (themeId) localStorage.setItem('tm-theme-id', themeId);
        if (themeMode) localStorage.setItem('tm-theme-mode', themeMode);
        if (surfacePackId) localStorage.setItem('tm-surface-id', surfacePackId);
        if (surface) localStorage.setItem('tm-surface-opts', JSON.stringify(surface));
        if (settings.appearance.accentColor) localStorage.setItem('tm-theme-accent', settings.appearance.accentColor);
      }

      if (!localStorage.getItem('praxis-onboarded')) {
        const workspaces = await window.praxis.workspaces.list();
        if (Array.isArray(workspaces) && workspaces.length > 0) {
          localStorage.setItem('praxis-onboarded', '1');
          localStorage.setItem('praxis-ai-onboarded', '1');
          localStorage.setItem('praxis-walkthrough-seen', '1');
          if (!localStorage.getItem('praxis-active-workspace')) {
            const connections = (await window.praxis.connection.list()) ?? [];
            const matchingWorkspace = workspaces.find((w: { projectIds?: string[] }) =>
              w.projectIds?.some((pid: string) =>
                connections?.some((c: { id?: string; settings?: { projectId?: string } }) =>
                  c.settings?.projectId === pid || c.id === `project:${pid}`
                )
              )
            ) ?? workspaces[0];
            if (matchingWorkspace?.id) {
              localStorage.setItem('praxis-active-workspace', matchingWorkspace.id);
              localStorage.setItem('praxis-recent-workspaces', JSON.stringify([matchingWorkspace.id]));
              const routeKey = `praxis-last-workspace-route:${matchingWorkspace.id}`;
              if (!localStorage.getItem(routeKey) && matchingWorkspace.defaultProjectId) {
                localStorage.setItem(routeKey, JSON.stringify({ projectId: matchingWorkspace.defaultProjectId }));
              }
            }
          }
        }
      }
    } catch (error) {
      console.error('Could not restore saved Praxis startup preferences:', error);
    }
  }
  await import('./main');
} catch (err) {
  console.error('[Praxis startup fatal error]', err);
  const root = document.getElementById('root');
  if (root) {
    root.innerHTML = `<div style="padding: 32px; color: #ff6b6b; font-family: ui-monospace, monospace; background: #1e1e1e; min-height: 100vh;">
      <h2 style="margin-top: 0;">Praxis Startup Error</h2>
      <pre style="white-space: pre-wrap; word-break: break-all;">${err instanceof Error ? err.stack || err.message : String(err)}</pre>
    </div>`;
  }
}
