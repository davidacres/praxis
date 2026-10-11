import type { ToolPermissionRequest } from './localTools';

/** Only filesystem reads/lists may bypass a prompt, after sandbox containment. */
export function shouldAutoAllowToolPermission(request: ToolPermissionRequest): boolean {
  return request.kind === 'read' || request.kind === 'list';
}
