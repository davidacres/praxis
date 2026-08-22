// The MCP client wrapper now lives in @ticket-manager/core so the desktop app
// shares it. This module stays as the extension-side import path.
export { McpClientWrapper, setMcpOAuthProviderSource } from '@ticket-manager/core';
export type { McpLogSink, McpOAuthProviderSource } from '@ticket-manager/core';
