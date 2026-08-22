// GitLabBoardService now lives in @ticket-manager/core so the desktop app
// shares it. This module stays as the extension-side import path.
export { GitLabBoardService } from '@ticket-manager/core';
export type { GitLabBoardServiceOptions, GitLabConfigStore } from '@ticket-manager/core';
