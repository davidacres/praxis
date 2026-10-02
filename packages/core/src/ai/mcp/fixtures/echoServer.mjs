// A minimal MCP server for tests: `echo` returns its text, `fail` reports an
// error result, and `whoami` returns an environment variable (to prove `env`
// reaches a stdio server). Speaks stdio.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'echo-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    { name: 'fail', description: 'Always errors', inputSchema: { type: 'object', properties: {} } },
    { name: 'whoami', description: 'Reads FIXTURE_NAME', inputSchema: { type: 'object', properties: {} } }
  ]
}));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args } = request.params;
  if (name === 'echo') return { content: [{ type: 'text', text: `echo:${args?.text}` }] };
  if (name === 'whoami') return { content: [{ type: 'text', text: `name=${process.env.FIXTURE_NAME ?? ''}` }] };
  return { isError: true, content: [{ type: 'text', text: 'boom' }] };
});
await server.connect(new StdioServerTransport());
