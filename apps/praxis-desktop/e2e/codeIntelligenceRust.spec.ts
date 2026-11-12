import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

// The Rust host drives the real code-intelligence service: prompt feedback looks identifiers up
// in the folder's index, and agent sessions get a stdio MCP bridge (the app binary re-executed
// with --code-intelligence-bridge) that answers tools/list and tools/call from that index.
const executable = process.env.PRAXIS_CODE_INTELLIGENCE_EXE;

test('feedback checks prompt identifiers against the index and the MCP bridge serves queries', async () => {
  test.skip(!executable, 'Set PRAXIS_CODE_INTELLIGENCE_EXE to a host package.');
  test.setTimeout(120_000);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pci-rs-'));
  const data = path.join(temporary, 'data');
  const source = path.join(temporary, 'repo');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'package.json'), '{ "scripts": { "test": "echo ok" } }\n');
  fs.writeFileSync(path.join(source, 'Widget.cs'), 'public class WidgetFactoryAlpha { public int Build() => 1; }\n');
  let app: TestApp | undefined;
  try {
    app = await launchTestApp(undefined, undefined, {
      AI_GATEWAY_API_KEY: 'gateway-fixture-key',
      PRAXIS_CODE_INTELLIGENCE_EXE: executable,
      PRAXIS_CODE_INTELLIGENCE_DATA_DIRECTORY: data
    });
    const win = app.window;
    const registered = await win.evaluate(root => window.praxis.ai.codeIntelligence({ action: 'register', root }), source);
    expect(registered.error).toBeUndefined();
    const repositoryId = (registered.data as { repositoryId: string }).repositoryId;
    await win.evaluate(id => window.praxis.ai.codeIntelligence({ action: 'index', repositoryId: id }), repositoryId);
    await expect.poll(async () => {
      const found = await win.evaluate(args => window.praxis.ai.codeIntelligence({ action: 'query', tool: 'find_symbol', arguments: args }),
        { repositoryId, name: 'WidgetFactoryAlpha', limit: 1 });
      return ((found.data as { items?: unknown[] } | undefined)?.items ?? []).length;
    }, { timeout: 60_000 }).toBeGreaterThan(0);

    const feedback = JSON.stringify(await win.evaluate(workingDirectory => window.praxis.ai.evaluatePrompt({
      promptText: 'rename `WidgetFactoryAlpha` and then fix `MissingThingBeta` in the repo', toolMode: 'full', workingDirectory
    }), source));
    expect(feedback).toContain('WidgetFactoryAlpha');
    expect(feedback).toContain('prompt-unknown-symbol');
    expect(feedback).toContain('MissingThingBeta');

    // The session bridge: grant the client, then speak MCP over stdio to the app binary.
    execFileSync(executable!, ['grant', repositoryId, '--client', 'fixture', '--data', data]);
    const bridge = spawn(process.env.PRAXIS_TAURI_BIN!, ['--code-intelligence-bridge', executable!, '-', data, repositoryId, 'fixture',
      path.join(path.dirname(executable!), 'contracts.json')], { stdio: ['pipe', 'pipe', 'ignore'] });
    try {
      const replies: Array<Record<string, any>> = [];
      let buffered = '';
      bridge.stdout!.on('data', chunk => {
        buffered += String(chunk);
        let newline: number;
        while ((newline = buffered.indexOf('\n')) >= 0) { replies.push(JSON.parse(buffered.slice(0, newline))); buffered = buffered.slice(newline + 1); }
      });
      const ask = async (id: number, method: string, params: unknown) => {
        bridge.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        await expect.poll(() => replies.find(reply => reply.id === id), { timeout: 30_000 }).toBeTruthy();
        return replies.find(reply => reply.id === id)!.result;
      };
      await ask(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
      const listed = await ask(2, 'tools/list', {});
      expect(listed.tools.map((tool: { name: string }) => tool.name)).toContain('find_symbol');
      const called = await ask(3, 'tools/call', { name: 'find_symbol', arguments: { name: 'WidgetFactoryAlpha', limit: 1 } });
      expect(called.isError).toBe(false);
      expect(called.structuredContent.data.items.length).toBeGreaterThan(0);
    } finally { bridge.kill(); }
  } finally {
    if (app) await closeTestApp(app);
    try { execFileSync(executable!, ['stop', '--data', data]); } catch { /* nothing running */ }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
