import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { WorkflowTransition } from '../types';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import type { AgentToolMode } from './agentTypes';
import type { PermissionDecision } from './tools';

export interface TrackerMcpSessionHooks {
  service: IssueTrackerService;
  toolMode: AgentToolMode;
  requestPermission?: (request: {
    kind: string;
    toolName: string;
    description: string;
    detail?: string;
  }) => Promise<PermissionDecision>;
  onToolCall?: (name: string, ok: boolean, content: string) => void;
}

export interface TrackerMcpRegistration {
  token: string;
  url: string;
  dispose(): void;
}

export const TRACKER_READ_TOOL_DEFINITIONS = [
  {
    name: 'tracker_get_ticket',
    description: 'Get the current details of a ticket from the session tracker connection.',
    inputSchema: {
      type: 'object' as const,
      properties: { issueKey: { type: 'string', description: 'Ticket key, for example APP-101' } },
      required: ['issueKey']
    }
  },
  {
    name: 'tracker_list_transitions',
    description: 'List the workflow transitions currently available for a ticket.',
    inputSchema: {
      type: 'object' as const,
      properties: { issueKey: { type: 'string' } },
      required: ['issueKey']
    }
  }
];

export const TRACKER_WRITE_TOOL_DEFINITIONS = [
  {
    name: 'tracker_add_comment',
    description: 'Add a comment or progress update to a ticket.',
    inputSchema: {
      type: 'object' as const,
      properties: { issueKey: { type: 'string' }, body: { type: 'string' } },
      required: ['issueKey', 'body']
    }
  },
  {
    name: 'tracker_update_ticket',
    description: 'Update editable ticket fields after user approval.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        issueKey: { type: 'string' },
        summary: { type: 'string' },
        description: { type: 'string' },
        assignee: { type: ['string', 'null'] },
        priority: { type: 'string' }
      },
      required: ['issueKey']
    }
  },
  {
    name: 'tracker_transition_ticket',
    description: 'Move a ticket through a workflow transition (e.g. to "In Progress", "In Review", or "Done"). Accepts transition ID or status name.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        issueKey: { type: 'string' },
        transitionId: { type: 'string', description: 'Transition ID or target status name, e.g. "In Progress", "In Review", "Done"' }
      },
      required: ['issueKey', 'transitionId']
    }
  }
];

export async function executeTrackerTool(
  name: string,
  args: Record<string, unknown>,
  service: IssueTrackerService,
  toolMode: AgentToolMode,
  requestPermission?: (request: {
    kind: string;
    toolName: string;
    description: string;
    detail?: string;
  }) => Promise<PermissionDecision>
): Promise<{ ok: boolean; content: string }> {
  try {
    const issueKey = typeof args.issueKey === 'string' ? args.issueKey.trim() : '';
    if (!issueKey) return { ok: false, content: 'issueKey is required.' };

    if (name === 'tracker_get_ticket') {
      const issue = await service.getIssue(issueKey);
      return { ok: true, content: JSON.stringify(issue, null, 2) };
    }

    if (name === 'tracker_list_transitions') {
      const transitions = await service.getTransitions(issueKey);
      return { ok: true, content: JSON.stringify(transitions, null, 2) };
    }

    if (toolMode === 'read-only') {
      return { ok: false, content: `Cannot execute write tool ${name} in read-only mode.` };
    }

    if (requestPermission) {
      const allowed = await requestPermission({
        kind: 'tracker-write',
        toolName: name,
        description: `Permission requested: ${name}`,
        detail: `The agent wants to use ${name} on ticket ${issueKey}.`
      });
      if (allowed === 'deny') return { ok: false, content: `Permission denied for ${name}.` };
    }

    if (name === 'tracker_add_comment') {
      const body = typeof args.body === 'string' ? args.body.trim() : '';
      if (!body) return { ok: false, content: 'body is required.' };
      await service.addComment(issueKey, body);
      return { ok: true, content: `Comment added to ${issueKey}.` };
    }

    if (name === 'tracker_update_ticket') {
      await service.updateIssue(issueKey, {
        summary: typeof args.summary === 'string' ? args.summary : undefined,
        description: typeof args.description === 'string' ? args.description : undefined,
        assignee: typeof args.assignee === 'string' || args.assignee === null ? args.assignee : undefined,
        priority: typeof args.priority === 'string' ? args.priority : undefined
      });
      return { ok: true, content: `Ticket ${issueKey} updated.` };
    }

    if (name === 'tracker_transition_ticket') {
      const rawTransition = typeof args.transitionId === 'string'
        ? args.transitionId.trim()
        : typeof args.targetStatus === 'string'
          ? args.targetStatus.trim()
          : '';
      if (!rawTransition) return { ok: false, content: 'transitionId is required.' };

      let effectiveId = rawTransition;
      try {
        const available = await service.getTransitions(issueKey);
        const match = available.find(
          (t: WorkflowTransition) =>
            t.id === rawTransition ||
            t.name.toLowerCase() === rawTransition.toLowerCase() ||
            t.toStatus?.toLowerCase() === rawTransition.toLowerCase() ||
            t.name.toLowerCase().includes(rawTransition.toLowerCase())
        );
        if (match) {
          effectiveId = match.id;
        }
      } catch {
        // fallback to raw ID
      }

      await service.transitionIssue(issueKey, effectiveId);
      return { ok: true, content: `Ticket ${issueKey} transitioned with ${effectiveId}.` };
    }

    return { ok: false, content: `Unknown tracker tool: ${name}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, content: message };
  }
}

export class TrackerMcpServer {
  private readonly sessions = new Map<string, TrackerMcpSessionHooks>();
  private server: http.Server | undefined;
  private port = 0;

  private async ensureListening(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => void this.handle(req, res));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        this.port = typeof address === 'object' && address ? address.port : 0;
        resolve();
      });
    });
  }

  async register(hooks: TrackerMcpSessionHooks): Promise<TrackerMcpRegistration> {
    await this.ensureListening();
    const token = randomUUID();
    this.sessions.set(token, hooks);
    return {
      token,
      url: `http://127.0.0.1:${this.port}/mcp/${token}`,
      dispose: () => {
        this.sessions.delete(token);
      }
    };
  }

  stop(): void {
    this.server?.close();
    this.server = undefined;
    this.port = 0;
  }

  private hooksFor(req: http.IncomingMessage): TrackerMcpSessionHooks | undefined {
    const match = /^\/mcp\/([0-9a-f-]{36})\/?$/i.exec((req.url ?? '').split('?')[0]);
    const pathToken = match?.[1];
    const auth = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!pathToken || (auth && auth !== pathToken)) return undefined;
    return this.sessions.get(pathToken);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const hooks = this.hooksFor(req);
    if (!hooks) {
      res.writeHead(404).end('unknown tracker session');
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: unknown;
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    } catch {
      res.writeHead(400).end('bad json');
      return;
    }

    const tools = hooks.toolMode === 'read-only'
      ? TRACKER_READ_TOOL_DEFINITIONS
      : [...TRACKER_READ_TOOL_DEFINITIONS, ...TRACKER_WRITE_TOOL_DEFINITIONS];

    const server = new Server(
      { name: 'praxis-tracker', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown>
      }))
    }));
    server.setRequestHandler(CallToolRequestSchema, async request => {
      const result = await executeTrackerTool(
        request.params.name,
        (request.params.arguments ?? {}) as Record<string, unknown>,
        hooks.service,
        hooks.toolMode,
        hooks.requestPermission
      );
      hooks.onToolCall?.(request.params.name, result.ok, result.content);
      return { content: [{ type: 'text', text: result.content }], isError: !result.ok };
    });

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }
}
