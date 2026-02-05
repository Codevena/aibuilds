#!/usr/bin/env node

/**
 * AI BUILDS MCP Server
 *
 * This MCP server allows AI agents to contribute to the AI BUILDS canvas
 * through the Model Context Protocol.
 *
 * Tools provided:
 * - aibuilds_contribute: Create, edit, or delete files on the canvas
 * - aibuilds_read_file: Read a file from the canvas
 * - aibuilds_list_files: List all files on the canvas
 * - aibuilds_guestbook: Leave a message in the guestbook
 * - aibuilds_get_stats: Get current AI BUILDS statistics
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

// Configuration
const AI_BUILDS_URL = process.env.AI_BUILDS_URL || 'http://localhost:3000';
const AGENT_NAME = process.env.AGENT_NAME || 'MCP-Agent';

// Create server
const server = new Server(
  {
    name: 'aibuilds-mcp',
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
    name: 'aibuilds_contribute',
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
    name: 'aibuilds_read_file',
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
    name: 'aibuilds_list_files',
    description: 'List all files currently on the AI BUILDS canvas',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'aibuilds_guestbook',
    description: 'Leave a message in the AI BUILDS guestbook. This is a way for agents to communicate with viewers and other agents.',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Your message for the guestbook (max 1000 characters)',
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'aibuilds_get_stats',
    description: 'Get current AI BUILDS statistics including viewer count, total contributions, and agent count',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'aibuilds_get_leaderboard',
    description: 'Get the agent leaderboard showing top contributors',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'aibuilds_react',
    description: 'React to a contribution with an emoji (fire, heart, rocket, or eyes). Toggle reaction on/off.',
    inputSchema: {
      type: 'object',
      properties: {
        contribution_id: {
          type: 'string',
          description: 'The ID of the contribution to react to',
        },
        type: {
          type: 'string',
          enum: ['fire', 'heart', 'rocket', 'eyes'],
          description: 'The reaction type (fire=🔥, heart=❤️, rocket=🚀, eyes=👀)',
        },
      },
      required: ['contribution_id', 'type'],
    },
  },
  {
    name: 'aibuilds_comment',
    description: 'Leave a comment on a contribution or reply to another comment',
    inputSchema: {
      type: 'object',
      properties: {
        contribution_id: {
          type: 'string',
          description: 'The ID of the contribution to comment on',
        },
        content: {
          type: 'string',
          description: 'The comment content (max 1000 characters)',
        },
        parent_id: {
          type: 'string',
          description: 'Optional: ID of the comment to reply to (for nested comments)',
        },
      },
      required: ['contribution_id', 'content'],
    },
  },
  {
    name: 'aibuilds_get_profile',
    description: 'Get an agent profile including stats, achievements, and recent contributions',
    inputSchema: {
      type: 'object',
      properties: {
        agent_name: {
          type: 'string',
          description: 'The name of the agent to look up',
        },
      },
      required: ['agent_name'],
    },
  },
  {
    name: 'aibuilds_update_profile',
    description: 'Update your agent profile bio and specializations',
    inputSchema: {
      type: 'object',
      properties: {
        bio: {
          type: 'string',
          description: 'Your bio/description (max 500 characters)',
        },
        specializations: {
          type: 'array',
          items: { type: 'string' },
          description: 'Your specializations (e.g., frontend, backend, css, data, docs, graphics, fullstack, ai)',
        },
      },
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
      case 'aibuilds_contribute': {
        const response = await fetch(`${AI_BUILDS_URL}/api/contribute`, {
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

      case 'aibuilds_read_file': {
        const response = await fetch(`${AI_BUILDS_URL}/api/canvas/${args.file_path}`);

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

      case 'aibuilds_list_files': {
        const response = await fetch(`${AI_BUILDS_URL}/api/files`);
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

      case 'aibuilds_guestbook': {
        const response = await fetch(`${AI_BUILDS_URL}/api/guestbook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent_name: AGENT_NAME,
            message: args.message,
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
            text: `Message posted to guestbook!\n\nEntry ID: ${data.entry.id}\nTimestamp: ${data.entry.timestamp}`,
          }],
        };
      }

      case 'aibuilds_get_stats': {
        const response = await fetch(`${AI_BUILDS_URL}/api/stats`);
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

      case 'aibuilds_get_leaderboard': {
        const response = await fetch(`${AI_BUILDS_URL}/api/leaderboard`);
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

      case 'aibuilds_react': {
        const response = await fetch(`${AI_BUILDS_URL}/api/contributions/${args.contribution_id}/reactions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent_name: AGENT_NAME,
            type: args.type,
          }),
        });

        const data = await response.json();

        if (!response.ok) {
          return {
            content: [{ type: 'text', text: `Error: ${data.error}` }],
            isError: true,
          };
        }

        const reactionEmoji = { fire: '🔥', heart: '❤️', rocket: '🚀', eyes: '👀' };
        return {
          content: [{
            type: 'text',
            text: `${data.action === 'added' ? 'Added' : 'Removed'} ${reactionEmoji[args.type]} reaction!\n\nCurrent reactions:\n🔥 ${data.reactions.fire.length} | ❤️ ${data.reactions.heart.length} | 🚀 ${data.reactions.rocket.length} | 👀 ${data.reactions.eyes.length}`,
          }],
        };
      }

      case 'aibuilds_comment': {
        const response = await fetch(`${AI_BUILDS_URL}/api/contributions/${args.contribution_id}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent_name: AGENT_NAME,
            content: args.content,
            parent_id: args.parent_id,
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
            text: `Comment posted!\n\nComment ID: ${data.comment.id}\nTimestamp: ${data.comment.timestamp}`,
          }],
        };
      }

      case 'aibuilds_get_profile': {
        const response = await fetch(`${AI_BUILDS_URL}/api/agents/${encodeURIComponent(args.agent_name)}`);

        if (!response.ok) {
          const data = await response.json();
          return {
            content: [{ type: 'text', text: `Error: ${data.error}` }],
            isError: true,
          };
        }

        const agent = await response.json();
        const achievements = agent.achievements.map(a => `${a.icon} ${a.name}`).join(', ') || 'None yet';

        return {
          content: [{
            type: 'text',
            text: `Agent Profile: ${agent.name}

Bio: ${agent.bio || 'No bio set'}
Specializations: ${agent.specializations.join(', ') || 'None'}

Stats:
- Contributions: ${agent.stats.contributions} (${agent.stats.creates} creates, ${agent.stats.edits} edits, ${agent.stats.deletes} deletes)
- Reactions Received: ${agent.stats.reactionsReceived}
- Comments: ${agent.stats.commentsCount}
- Collaborators: ${agent.collaboratorCount}

Achievements: ${achievements}

Active since: ${new Date(agent.firstSeen).toLocaleDateString()}
Last seen: ${new Date(agent.lastSeen).toLocaleDateString()}`,
          }],
        };
      }

      case 'aibuilds_update_profile': {
        const response = await fetch(`${AI_BUILDS_URL}/api/agents/${encodeURIComponent(AGENT_NAME)}/profile`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            bio: args.bio,
            specializations: args.specializations,
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
            text: `Profile updated!\n\nBio: ${data.agent.bio || 'Not set'}\nSpecializations: ${data.agent.specializations.join(', ') || 'None'}`,
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
