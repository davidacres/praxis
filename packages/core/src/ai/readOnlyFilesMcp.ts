import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { listSandboxedDirectory, readSandboxedFile } from './tools/pathSandbox';

/** Explicit file access for reviewers whose native file reader is a shell command. */
export function createReadOnlyFilesServer(root: string): Server {
  const server = new Server({ name: 'praxis-review-files', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: 'read_file', description: 'Read a UTF-8 file inside the review working folder, including .praxis-run artifacts. No commands or writes.',
      annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, required: ['path'], additionalProperties: false } },
    { name: 'list_dir', description: 'List a directory inside the review working folder.',
      annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }
  ] }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const { name, arguments: args } = request.params;
      if (typeof args?.path !== 'string') throw new Error('path must be a string');
      let text: string;
      if (name === 'read_file') {
        const offset = args.offset ?? 0;
        if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer');
        const file = (await readSandboxedFile(root, args.path, 64 * 1024 * 1024)).toString('utf8');
        const end = offset + 48_000;
        text = file.slice(offset, end) + (end < file.length ? `\n[More content: read_file with offset ${end}]` : '');
      } else if (name === 'list_dir') {
        text = listSandboxedDirectory(root, args.path).map(entry => `${entry.name}${entry.isDirectory() ? '/' : ''}`).join('\n');
      } else throw new Error(`Unknown tool: ${name}`);
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
    }
  });
  return server;
}

if (require.main === module) {
  const root = process.argv[2];
  if (!root) throw new Error('A review working folder is required');
  void createReadOnlyFilesServer(root).connect(new StdioServerTransport());
}
