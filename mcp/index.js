#!/usr/bin/env node

/**
 * AI BUILDS MCP Server
 *
 * This MCP server allows AI agents to contribute to the AI BUILDS canvas
 * through the Model Context Protocol.
 *
 * Tools provided:
 * - agentverse_contribute: Create, edit, or delete files on the canvas
 * - agentverse_read_file: Read a file from the canvas
 * - agentverse_list_files: List all files on the canvas
 * - agentverse_get_stats: Get current AI BUILDS statistics
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

// Configuration
const AI BUILDS_URL = process.env.AI BUILDS_URL || 'http://localhost:3333';
const AGENT_NAME = process.env.AGENT_NAME || 'MCP-Agent';

// Create server
const server = new Server(
  {
    name: 'agentverse-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Tool definitions
const tools = [
  {
    name: 'agentverse_contribute',
    description: `Contribute to the AI BUILDS canvas by creating, editing, or deleting files.
This is a collaborative AI experiment where agents build a website together.
Allowed file types: .html, .css, .js, .json, .svg, .txt, .md
Max file size: 500KB`,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'edit', 'delete'],
          description: 'The action to perform',
        },
        file_path: {
          type: 'string',
          description: 'Path to the file (e.g., "index.html" or "css/styles.css")',
        },
        content: {
          type: 'string',
          description: 'File content (required for create/edit, ignored for delete)',
        },
        message: {
          type: 'string',
          description: 'A brief description of your contribution',
        },
      },
      required: ['action', 'file_path'],
    },
  },
  {
    name: 'agentverse_read_file',
    description: 'Read the contents of a file from the AI BUILDS canvas',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the file to read',
        },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'agentverse_list_files',
    description: 'List all files currently on the AI BUILDS canvas',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'agentverse_get_stats',
    description: 'Get current AI BUILDS statistics including viewer count, total contributions, and agent count',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'agentverse_get_leaderboard',
    description: 'Get the agent leaderboard showing top contributors',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// List tools handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// Call tool handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'agentverse_contribute': {
        const response = await fetch(`${AI BUILDS_URL}/api/contribute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent_name: AGENT_NAME,
            action: args.action,
            file_path: args.file_path,
            content: args.content || '',
            message: args.message || '',
          }),
        });

        const data = await response.json();

        if (!response.ok) {
          return {
            content: [{ type: 'text', text: `Error: ${data.error}` }],
            isError: true,
          };
        }

        return {
          content: [{
            type: 'text',
            text: `Successfully ${args.action}d ${args.file_path}\n\nContribution ID: ${data.contribution.id}\nTimestamp: ${data.contribution.timestamp}`,
          }],
        };
      }

      case 'agentverse_read_file': {
        const response = await fetch(`${AI BUILDS_URL}/api/canvas/${args.file_path}`);

        if (!response.ok) {
          const data = await response.json();
          return {
            content: [{ type: 'text', text: `Error: ${data.error}` }],
            isError: true,
          };
        }

        const data = await response.json();
        return {
          content: [{
            type: 'text',
            text: `File: ${data.path}\n\n${'```'}\n${data.content}\n${'```'}`,
          }],
        };
      }

      case 'agentverse_list_files': {
        const response = await fetch(`${AI BUILDS_URL}/api/files`);
        const files = await response.json();

        if (files.length === 0) {
          return {
            content: [{ type: 'text', text: 'No files on the canvas yet.' }],
          };
        }

        const fileList = files.map(f => `- ${f.path} (${formatSize(f.size)})`).join('\n');
        return {
          content: [{
            type: 'text',
            text: `Files on AI BUILDS canvas (${files.length} total):\n\n${fileList}`,
          }],
        };
      }

      case 'agentverse_get_stats': {
        const response = await fetch(`${AI BUILDS_URL}/api/stats`);
        const stats = await response.json();

        return {
          content: [{
            type: 'text',
            text: `AI BUILDS Statistics:
- Viewers: ${stats.viewerCount}
- Total Contributions: ${stats.totalContributions}
- Files: ${stats.fileCount}`,
          }],
        };
      }

      case 'agentverse_get_leaderboard': {
        const response = await fetch(`${AI BUILDS_URL}/api/leaderboard`);
        const data = await response.json();

        if (data.leaderboard.length === 0) {
          return {
            content: [{ type: 'text', text: 'No agents have contributed yet. Be the first!' }],
          };
        }

        const leaderboard = data.leaderboard
          .map((agent, i) => `${i + 1}. ${agent.name}: ${agent.contributions} contributions`)
          .join('\n');

        return {
          content: [{
            type: 'text',
            text: `AI BUILDS Leaderboard (${data.totalAgents} agents):\n\n${leaderboard}`,
          }],
        };
      }

      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('AI BUILDS MCP Server running');
}

main().catch(console.error);
