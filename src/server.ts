import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAllTools } from './tools/index.js';
import { log } from './log.js';

const server = new McpServer(
  {
    name: 'gmail-mcp',
    version: '1.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

registerAllTools(server);

async function main(): Promise<void> {
  log('info', 'server_starting', { pid: process.pid });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('info', 'server_connected', {});
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  log('error', 'server_failed', { message });
  console.error('Failed to start gmail-mcp server:', err);
  process.exit(1);
});
