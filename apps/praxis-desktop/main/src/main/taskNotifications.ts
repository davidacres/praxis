import { app, BrowserWindow, Notification } from 'electron';
import type { TaskNotificationTarget } from '@praxis/core';
import { trustedIpcMain as ipcMain } from './trustedIpcMain';
import { getSettingsBackend } from './settingsBackendInstance';
import { safeSend } from './windowBroadcast';
import { TaskNotificationPolicy, shouldNotify, type TaskNotice } from './taskNotificationPolicy';

export const taskNotificationPolicy = new TaskNotificationPolicy();
const views = new Map<number, TaskNotificationTarget>();
const notifications = new Set<Notification>();

export function registerTaskNotifications(): void {
  // Match the AppUserModelID of the installed Windows Start Menu shortcut.
  if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? 'com.praxis.app' : process.execPath);
  ipcMain.handle('window:setNotificationView', (event, value: unknown) => {
    const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const target: TaskNotificationTarget = {};
    for (const key of ['sessionKey', 'runId'] as const) {
      if (typeof raw[key] === 'string' && raw[key].length < 512) target[key] = raw[key];
    }
    const id = event.sender.id;
    if (!views.has(id)) event.sender.once('destroyed', () => views.delete(id));
    views.set(id, target);
  });
}

/** Best effort: notification failures must never interrupt a provider or workflow. */
export function deliverTaskNotice(notice: TaskNotice | undefined): void {
  if (!notice) return;
  try {
    const settings = getSettingsBackend().read().notifications;
    const windows = BrowserWindow.getAllWindows().filter(win => !win.isDestroyed());
    const focusedViews = windows.filter(win => win.isFocused() && win.isVisible() && !win.isMinimized())
      .map(win => views.get(win.webContents.id) ?? {});
    if (!shouldNotify(notice, settings, focusedViews) || !Notification.isSupported()) return;
    const notification = new Notification({ title: notice.title, body: notice.body, silent: !settings.sound });
    // Bound retained native objects even on platforms that omit close events.
    if (notifications.size >= 100) notifications.delete(notifications.values().next().value!);
    notifications.add(notification);
    const release = () => notifications.delete(notification);
    notification.once('close', release);
    notification.once('failed', (_event, error) => {
      release();
      console.warn('Task notification could not be displayed:', error);
    });
    notification.once('click', () => {
      const candidates = BrowserWindow.getAllWindows().filter(candidate => !candidate.isDestroyed() && views.has(candidate.webContents.id));
      const detached = notice.target.sessionKey && candidates.find(candidate =>
        new URL(candidate.webContents.getURL()).searchParams.get('detachedSession') === notice.target.sessionKey);
      const win = detached || candidates.find(candidate => !new URL(candidate.webContents.getURL()).searchParams.has('detachedSession'));
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.show();
      if (!detached) safeSend(win, 'window:notificationOpen', notice.target);
      win.focus();
    });
    notification.show();
  } catch (error) {
    console.warn('Task notification could not be displayed:', error);
  }
}
