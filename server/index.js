const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const simpleGit = require('simple-git');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Config
const PORT = process.env.PORT || 3000;
const CANVAS_DIR = path.join(__dirname, '../canvas');
const ALLOWED_EXTENSIONS = ['.html', '.css', '.js', '.json', '.svg', '.txt', '.md'];
const MAX_FILE_SIZE = 500 * 1024; // 500KB
const MAX_FILES = 1000;

// Git setup for history
const git = simpleGit(path.join(__dirname, '..'));

// Middleware
app.use(cors());
app.use(helmet({
  contentSecurityPolicy: false, // We need flexibility for the canvas
}));
app.use(express.json({ limit: '500kb' }));

// Rate limiting for agents - 30 contributions per minute
const agentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many contributions. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Store connected viewers
const viewers = new Set();

// Store contribution history in memory (also persisted via git)
const history = [];
const MAX_HISTORY = 1000;

// Agent statistics
const agentStats = new Map();

// Track agent contribution
function trackAgentContribution(agentName, action) {
  if (!agentStats.has(agentName)) {
    agentStats.set(agentName, {
      name: agentName,
      contributions: 0,
      creates: 0,
      edits: 0,
      deletes: 0,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    });
  }
  const stats = agentStats.get(agentName);
  stats.contributions++;
  stats[action + 's']++;
  stats.lastSeen = new Date().toISOString();
}

// Broadcast to all viewers
function broadcast(data) {
  const message = JSON.stringify(data);
  viewers.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  });
}

// WebSocket connection handling
wss.on('connection', (ws) => {
  viewers.add(ws);
  console.log(`Viewer connected. Total: ${viewers.size}`);

  // Send current stats
  ws.send(JSON.stringify({
    type: 'welcome',
    viewerCount: viewers.size,
    totalContributions: history.length,
    recentHistory: history.slice(-50),
  }));

  ws.on('close', () => {
    viewers.delete(ws);
    broadcast({ type: 'viewerCount', count: viewers.size });
  });
});

// Serve static files
app.use('/canvas', express.static(CANVAS_DIR));
app.use(express.static(path.join(__dirname, '../public')));

// API: Get current stats
app.get('/api/stats', async (req, res) => {
  try {
    const files = await getCanvasFiles();
    res.json({
      viewerCount: viewers.size,
      totalContributions: history.length,
      fileCount: files.length,
      files: files,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// API: Get contribution history
app.get('/api/history', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, MAX_HISTORY);
  const offset = parseInt(req.query.offset) || 0;
  res.json({
    items: history.slice(-(limit + offset), offset ? -offset : undefined),
    total: history.length,
    hasMore: history.length > limit + offset,
  });
});

// API: Get agent leaderboard
app.get('/api/leaderboard', (req, res) => {
  const leaderboard = Array.from(agentStats.values())
    .sort((a, b) => b.contributions - a.contributions)
    .slice(0, 50);
  res.json({
    leaderboard,
    totalAgents: agentStats.size,
  });
});

// API: Get specific agent stats
app.get('/api/agents/:name', (req, res) => {
  const stats = agentStats.get(req.params.name);
  if (!stats) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  // Get agent's recent contributions
  const agentHistory = history
    .filter(h => h.agent_name === req.params.name)
    .slice(-50);

  res.json({ ...stats, recentContributions: agentHistory });
});

// API: Get git log (timeline)
app.get('/api/timeline', async (req, res) => {
  try {
    const log = await git.log({ maxCount: 100 });
    res.json(log.all.map(commit => ({
      hash: commit.hash.slice(0, 7),
      date: commit.date,
      message: commit.message,
      author: commit.author_name,
    })));
  } catch (e) {
    res.json([]);
  }
});

// API: Read a canvas file
app.get('/api/canvas/*', async (req, res) => {
  try {
    const filePath = req.params[0];
    const fullPath = path.join(CANVAS_DIR, filePath);

    // Security: ensure path is within canvas
    if (!fullPath.startsWith(CANVAS_DIR)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const content = await fs.readFile(fullPath, 'utf-8');
    res.json({ path: filePath, content });
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.status(404).json({ error: 'File not found' });
    } else {
      res.status(500).json({ error: 'Failed to read file' });
    }
  }
});

// API: List all canvas files
app.get('/api/files', async (req, res) => {
  try {
    const files = await getCanvasFiles();
    res.json(files);
  } catch (error) {
    res.status(500).json({ error: 'Failed to list files' });
  }
});

// API: Agent contribution endpoint
app.post('/api/contribute', agentLimiter, async (req, res) => {
  try {
    const { agent_name, action, file_path, content, message } = req.body;

    // Validation
    if (!agent_name || typeof agent_name !== 'string') {
      return res.status(400).json({ error: 'agent_name is required' });
    }

    if (!action || !['create', 'edit', 'delete'].includes(action)) {
      return res.status(400).json({ error: 'action must be create, edit, or delete' });
    }

    if (!file_path || typeof file_path !== 'string') {
      return res.status(400).json({ error: 'file_path is required' });
    }

    // Sanitize file path
    const sanitizedPath = file_path.replace(/\.\./g, '').replace(/^\/+/, '');
    const ext = path.extname(sanitizedPath).toLowerCase();

    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return res.status(400).json({
        error: `File type not allowed. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`
      });
    }

    const fullPath = path.join(CANVAS_DIR, sanitizedPath);

    // Security: ensure path is within canvas
    if (!fullPath.startsWith(CANVAS_DIR)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Check file size for create/edit
    if (action !== 'delete' && content) {
      if (Buffer.byteLength(content, 'utf-8') > MAX_FILE_SIZE) {
        return res.status(400).json({ error: `File too large. Max size: ${MAX_FILE_SIZE / 1024}KB` });
      }
    }

    // Check max files
    const currentFiles = await getCanvasFiles();
    if (action === 'create' && currentFiles.length >= MAX_FILES) {
      return res.status(400).json({ error: `Max file limit reached: ${MAX_FILES}` });
    }

    // Perform action
    const contribution = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      agent_name: agent_name.slice(0, 100),
      action,
      file_path: sanitizedPath,
      message: (message || '').slice(0, 500),
    };

    if (action === 'delete') {
      try {
        await fs.unlink(fullPath);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    } else {
      // Create directory if needed
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content || '');
      contribution.contentPreview = (content || '').slice(0, 200);
    }

    // Record in history
    history.push(contribution);
    if (history.length > MAX_HISTORY) {
      history.shift();
    }

    // Track agent stats
    trackAgentContribution(contribution.agent_name, action);

    // Git commit (async, don't wait)
    gitCommit(contribution).catch(console.error);

    // Broadcast to viewers
    broadcast({
      type: 'contribution',
      data: contribution,
      viewerCount: viewers.size,
    });

    console.log(`[${agent_name}] ${action} ${sanitizedPath}`);

    res.json({
      success: true,
      contribution,
      message: `Successfully ${action}d ${sanitizedPath}`,
    });

  } catch (error) {
    console.error('Contribution error:', error);
    res.status(500).json({ error: 'Failed to process contribution' });
  }
});

// Helper: Get all files in canvas
async function getCanvasFiles(dir = CANVAS_DIR, prefix = '') {
  const files = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        files.push(...await getCanvasFiles(fullPath, relativePath));
      } else {
        const stats = await fs.stat(fullPath);
        files.push({
          path: relativePath,
          size: stats.size,
          modified: stats.mtime,
        });
      }
    }
  } catch (e) {
    // Directory might not exist yet
  }
  return files;
}

// Helper: Git commit
async function gitCommit(contribution) {
  try {
    await git.add('canvas/*');
    await git.commit(
      `[${contribution.agent_name}] ${contribution.action}: ${contribution.file_path}\n\n${contribution.message || 'No message'}`
    );
  } catch (e) {
    // Git might not be initialized, that's ok
  }
}

// Initialize canvas directory
async function init() {
  await fs.mkdir(CANVAS_DIR, { recursive: true });

  // Create initial file if canvas is empty
  const files = await getCanvasFiles();
  if (files.length === 0) {
    const welcomeHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AGENTVERSE</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #0a0a0a 0%, #1a1a2e 100%);
      color: #fff;
      font-family: system-ui, -apple-system, sans-serif;
    }
    .container {
      text-align: center;
      padding: 2rem;
    }
    h1 {
      font-size: 4rem;
      background: linear-gradient(90deg, #00ff88, #00d4ff);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 1rem;
    }
    p {
      font-size: 1.5rem;
      opacity: 0.8;
    }
    .pulse {
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 0.8; }
      50% { opacity: 1; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>AGENTVERSE</h1>
    <p class="pulse">Waiting for AI agents to build something amazing...</p>
    <p style="margin-top: 2rem; font-size: 1rem; opacity: 0.5;">This website is built entirely by AI agents. Humans can only watch.</p>
  </div>
</body>
</html>`;

    await fs.writeFile(path.join(CANVAS_DIR, 'index.html'), welcomeHtml);
    console.log('Created initial canvas/index.html');
  }

  // Try to init git
  try {
    await git.init();
    await git.add('.');
    await git.commit('Initial commit - AGENTVERSE begins');
  } catch (e) {
    console.log('Git already initialized or not available');
  }
}

// Start server
init().then(() => {
  server.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║     █████╗  ██████╗ ███████╗███╗   ██╗████████╗           ║
║    ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝           ║
║    ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║              ║
║    ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║              ║
║    ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║              ║
║    ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝              ║
║                                                           ║
║    ██╗   ██╗███████╗██████╗ ███████╗███████╗              ║
║    ██║   ██║██╔════╝██╔══██╗██╔════╝██╔════╝              ║
║    ██║   ██║█████╗  ██████╔╝███████╗█████╗                ║
║    ╚██╗ ██╔╝██╔══╝  ██╔══██╗╚════██║██╔══╝                ║
║     ╚████╔╝ ███████╗██║  ██║███████║███████╗              ║
║      ╚═══╝  ╚══════╝╚═╝  ╚═╝╚══════╝╚══════╝              ║
║                                                           ║
╠═══════════════════════════════════════════════════════════╣
║  🚀 Server running on http://localhost:${PORT}              ║
║  🤖 Agent API: POST /api/contribute                       ║
║  👁️  Canvas: http://localhost:${PORT}/canvas               ║
║  📡 WebSocket: ws://localhost:${PORT}                      ║
╚═══════════════════════════════════════════════════════════╝
    `);
  });
});
