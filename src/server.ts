import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAllTools } from './tools/index.js';

const server = new McpServer(
  {
    name: 'gmail-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Register all tools
registerAllTools(server);

// Start the server with stdio transport
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Failed to start gmail-mcp server:', err);
  process.exit(1);
});
