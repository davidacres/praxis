import * as vscode from 'vscode';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ConnectionConfig, ToolCallPayload, ToolDescriptor } from '../types';
import { getMcpOAuthManager } from './oauthManager';

type McpClientInstance = Client;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractTextBlocks(response: unknown): string[] {
  if (!isRecord(response) || !Array.isArray(response.content)) {
    return [];
  }

  const textBlocks: string[] = [];
  for (const item of response.content) {
    if (!isRecord(item)) {
      continue;
    }

    if (item.type === 'text' && typeof item.text === 'string') {
      textBlocks.push(item.text);
      continue;
    }

    if (item.type === 'resource' && isRecord(item.resource) && typeof item.resource.text === 'string') {
      textBlocks.push(item.resource.text);
    }
  }

  return textBlocks;
}

function getPayloadValue(response: unknown, textBlocks: string[]): unknown {
  if (isRecord(response) && 'structuredContent' in response) {
    return response.structuredContent;
  }

  if (isRecord(response) && 'toolResult' in response) {
    return response.toolResult;
  }

  if (textBlocks.length === 1) {
    return tryParseJson(textBlocks[0]);
  }

  if (textBlocks.length > 1) {
    return textBlocks.map(block => tryParseJson(block));
  }

  return response;
}

function isErrorResponse(response: unknown): boolean {
  return isRecord(response) && response.isError === true;
}

function getErrorMessage(name: string, response: unknown, textBlocks: string[]): string {
  if (textBlocks.length > 0) {
    return `${name} failed: ${textBlocks.join('\n')}`;
  }

  if (isRecord(response) && typeof response.message === 'string') {
    return `${name} failed: ${response.message}`;
  }

  return `${name} failed with an unknown MCP error.`;
}

export class McpClientWrapper implements vscode.Disposable {
  private client?: McpClientInstance;
  private currentConfig?: ConnectionConfig;
  private connectionSignature?: string;
  private stderrListener?: (chunk: Buffer | string) => void;

  public constructor(private readonly output: vscode.OutputChannel) {}

  public async connect(config: ConnectionConfig): Promise<void> {
    const signature = JSON.stringify(config);
    if (this.client && this.connectionSignature === signature) {
      return;
    }

    await this.disconnect();

    const client = new Client(
      { name: 'ticket-manager', version: '0.0.1' },
      {
        capabilities: {}
      }
    );

    const transport =
      config.type === 'http'
        ? new StreamableHTTPClientTransport(new URL(config.url), {
            authProvider: getMcpOAuthManager()?.createProvider(config.url),
            requestInit: {
              headers: config.headers
            }
          })
        : new StdioClientTransport({
            command: config.command,
            args: config.args,
            cwd: config.cwd,
            env: {
              ...Object.fromEntries(
                Object.entries(process.env).filter((entry): entry is [string, string] =>
                  typeof entry[1] === 'string'
                )
              ),
              ...config.env
            },
            stderr: 'pipe'
          });

    if (transport instanceof StdioClientTransport && transport.stderr) {
      this.stderrListener = chunk => {
        const text = String(chunk).trim();
        if (text.length > 0) {
          this.output.appendLine(`[mcp stderr] ${text}`);
        }
      };
      transport.stderr.on('data', this.stderrListener);
    }

    this.output.appendLine(`[mcp] Connecting using ${config.type}.`);
    try {
      await client.connect(transport, { timeout: config.timeoutMs });
    } catch (error) {
      if (
        config.type === 'http' &&
        transport instanceof StreamableHTTPClientTransport &&
        error instanceof UnauthorizedError
      ) {
        const oauthManager = getMcpOAuthManager();
        if (!oauthManager) {
          throw error;
        }

        this.output.appendLine('[mcp] Authorization required. Waiting for browser sign-in to complete.');
        const authorizationCode = await oauthManager.waitForAuthorizationCode();
        await transport.finishAuth(authorizationCode);
        await client.connect(transport, { timeout: config.timeoutMs });
      } else {
        throw error;
      }
    }

    const serverVersion = client.getServerVersion();
    if (serverVersion) {
      this.output.appendLine(
        `[mcp] Connected to ${serverVersion.name} ${serverVersion.version}.`
      );
    } else {
      this.output.appendLine('[mcp] Connected to server.');
    }

    this.client = client;
    this.currentConfig = config;
    this.connectionSignature = signature;
  }

  public async disconnect(): Promise<void> {
    if (!this.client) {
      this.connectionSignature = undefined;
      return;
    }

    try {
      await this.client.close();
    } catch (error) {
      this.output.appendLine(`[mcp] Close error: ${(error as Error).message}`);
    } finally {
      this.client = undefined;
      this.currentConfig = undefined;
      this.connectionSignature = undefined;
      this.stderrListener = undefined;
    }
  }

  public getServerName(): string | undefined {
    return this.client?.getServerVersion()?.name;
  }

  public async listTools(timeoutMs: number): Promise<ToolDescriptor[]> {
    if (!this.client) {
      throw new Error('MCP client is not connected.');
    }

    const response = await this.runWithUnauthorizedReconnect(
      () => this.client!.listTools(undefined, { timeout: timeoutMs }),
      'list tools'
    );
    return response.tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      readOnlyHint: tool.annotations?.readOnlyHint
    }));
  }

  public async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number
  ): Promise<ToolCallPayload> {
    if (!this.client) {
      throw new Error('MCP client is not connected.');
    }

    this.output.appendLine(`[mcp] Calling tool ${name}.`);
    const response = await this.runWithUnauthorizedReconnect(
      () =>
        this.client!.callTool({ name, arguments: args }, undefined, {
          timeout: timeoutMs
        }),
      `call tool ${name}`
    );
    const textBlocks = extractTextBlocks(response);

    if (isErrorResponse(response)) {
      throw new Error(getErrorMessage(name, response, textBlocks));
    }

    return {
      raw: response,
      value: getPayloadValue(response, textBlocks),
      textBlocks
    };
  }

  public dispose(): void {
    void this.disconnect();
  }

  private async runWithUnauthorizedReconnect<T>(
    operation: () => Promise<T>,
    label: string
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof UnauthorizedError) || this.currentConfig?.type !== 'http') {
        throw error;
      }

      const config = this.currentConfig;
      this.output.appendLine(`[mcp] Authorization expired while attempting to ${label}. Reconnecting.`);
      await this.disconnect();
      await this.connect(config);
      return operation();
    }
  }
}
