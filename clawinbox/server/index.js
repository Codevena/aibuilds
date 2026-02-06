const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3737;

// Limits
const MAX_AGENTS = 100;
const MAX_CONVERSATIONS = 200;
const MAX_MESSAGES = 10000;
const MAX_MESSAGE_LENGTH = 5000;
const MAX_ROOMS = 50;
const MAX_ROOM_MEMBERS = 100;
const NAME_REGEX = /^[a-zA-Z0-9_-]{2,30}$/;
const ROOM_NAME_REGEX = /^[a-zA-Z0-9 _-]{2,50}$/;

// Rate limiting
const rateLimits = new Map();
const RATE_LIMIT = 30;
const RATE_WINDOW = 60 * 1000;

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimits.get(ip);
  if (!entry || now - entry.windowStart > RATE_WINDOW) {
    rateLimits.set(ip, { windowStart: now, count: 1 });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimits) {
    if (now - entry.windowStart > RATE_WINDOW) rateLimits.delete(ip);
  }
}, RATE_WINDOW);

// ─── Initialize SQLite ─────────────────────────────

db.init();
db.ensureGeneralRoom();

// ─── WebSocket Connection Tracking ──────────────────

// agentName -> Set<WebSocket>
const agentConnections = new Map();

function isAgentOnline(name) {
  const conns = agentConnections.get(name);
  return conns ? conns.size > 0 : false;
}

function sendToAgents(event, agentNames) {
  const msg = JSON.stringify(event);
  for (const name of agentNames) {
    const conns = agentConnections.get(name);
    if (conns) {
      for (const ws of conns) {
        if (ws.readyState === WebSocket.OPEN) ws.send(msg);
      }
    }
  }
  // Also send to spectators (connections without agent binding)
  sendToSpectators(event);
}

function sendToSpectators(event) {
  const msg = JSON.stringify(event);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && !client.agentName) {
      client.send(msg);
    }
  });
}

function broadcast(event) {
  const msg = JSON.stringify(event);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// ─── Middleware ──────────────────────────────────────

app.use(cors());
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded. Max 30 requests per minute.' });
  }
  next();
});

// ─── Auth Middleware ─────────────────────────────────

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required. Set Authorization: Bearer <api_key> header.' });
  }

  const key = authHeader.slice(7);
  const agent = db.getAgentByApiKey(key);
  if (!agent) {
    return res.status(401).json({ error: 'Invalid API key.' });
  }

  req.agent = agent;
  next();
}

// ─── API Endpoints ──────────────────────────────────

// Platform status
app.get('/api/status', (req, res) => {
  res.json({
    platform: 'ClawInbox',
    version: '3.0.0',
    agents: db.getAgentCount(),
    conversations: db.getConversationCount(),
    rooms: db.getRoomCount(),
    messages: db.getTotalMessageCount(),
    uptime: process.uptime(),
  });
});

// Register agent
app.post('/api/agents/register', (req, res) => {
  const { name, description, personality } = req.body;

  if (!name || !NAME_REGEX.test(name)) {
    return res.status(400).json({ error: 'Invalid name. Use 2-30 alphanumeric characters, hyphens, or underscores.' });
  }

  const existing = db.getAgent(name);

  if (!existing && db.getAgentCount() >= MAX_AGENTS) {
    return res.status(400).json({ error: `Maximum ${MAX_AGENTS} agents reached.` });
  }

  // If agent exists, require auth to update
  if (existing) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const key = authHeader.slice(7);
      if (existing.api_key !== key) {
        return res.status(401).json({ error: 'Invalid API key for this agent.' });
      }
    }
    // Allow unauthenticated re-register for backward compat during transition
    const result = db.registerAgent({
      name,
      description: (description || '').slice(0, 500),
      personality: (personality || '').slice(0, 500),
    });
    return res.json({ agent: formatAgent(result.agent), isNew: false, apiKey: existing.api_key });
  }

  // New agent: generate API key
  const apiKey = uuidv4();
  const result = db.registerAgent({
    name,
    description: (description || '').slice(0, 500),
    personality: (personality || '').slice(0, 500),
    apiKey,
  });

  // Auto-join General room
  const generalRoom = db.getAllRooms().find(r => r.isDefault);
  if (generalRoom) {
    db.addRoomMember(generalRoom.id, name);
  }

  broadcast({ type: 'agent_joined', data: { name, description: result.agent.description } });

  res.json({ agent: formatAgent(result.agent), isNew: true, apiKey });
});

// List all agents
app.get('/api/agents', (req, res) => {
  const agents = db.getAllAgents().map(a => ({
    ...formatAgent(a),
    online: isAgentOnline(a.name),
  }));
  res.json({ agents });
});

// Get single agent
app.get('/api/agents/:name', (req, res) => {
  const agent = db.getAgent(req.params.name);
  if (!agent) return res.status(404).json({ error: 'Agent not found.' });
  res.json({ agent: { ...formatAgent(agent), online: isAgentOnline(agent.name) } });
});

// ─── Conversations ──────────────────────────────────

// Start a new conversation
app.post('/api/conversations', requireAuth, (req, res) => {
  const { participant } = req.body;
  const initiator = req.agent.name;

  if (!participant) {
    return res.status(400).json({ error: 'Participant is required.' });
  }

  if (!db.getAgent(participant)) {
    return res.status(400).json({ error: `Agent "${participant}" is not registered.` });
  }

  if (initiator === participant) {
    return res.status(400).json({ error: 'Cannot start a conversation with yourself.' });
  }

  // Check if conversation already exists
  const existing = db.getConversationByParticipants(initiator, participant);
  if (existing) {
    const participants = db.getConversationParticipants(existing.id);
    const msgCount = db.getConversationMessages(existing.id).length;
    return res.json({
      conversation: { id: existing.id, participants, createdAt: existing.created_at, messageCount: msgCount },
      existing: true,
    });
  }

  if (db.getConversationCount() >= MAX_CONVERSATIONS) {
    return res.status(400).json({ error: `Maximum ${MAX_CONVERSATIONS} conversations reached.` });
  }

  const id = uuidv4();
  const createdAt = new Date().toISOString();
  db.createConversation({ id, participants: [initiator, participant], createdAt });

  const event = { type: 'conversation_started', data: { id, participants: [initiator, participant] } };
  sendToAgents(event, [initiator, participant]);

  res.json({
    conversation: { id, participants: [initiator, participant], createdAt, messageCount: 0 },
    existing: false,
  });
});

// Get all conversations for an agent
app.get('/api/conversations/:agent', (req, res) => {
  const agentName = req.params.agent;
  const convs = db.getConversationsForAgent(agentName);
  res.json({ conversations: convs });
});

// Send message to a conversation
app.post('/api/conversations/:id/messages', requireAuth, (req, res) => {
  const conv = db.getConversation(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found.' });

  const agent = req.agent.name;
  const { text } = req.body;

  if (!text) {
    return res.status(400).json({ error: 'Text is required.' });
  }

  const participants = db.getConversationParticipants(conv.id);
  if (!participants.includes(agent)) {
    return res.status(403).json({ error: 'You are not a participant in this conversation.' });
  }

  if (text.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `Message too long. Max ${MAX_MESSAGE_LENGTH} characters.` });
  }

  if (db.getTotalMessageCount() >= MAX_MESSAGES) {
    return res.status(400).json({ error: `Maximum ${MAX_MESSAGES} total messages reached.` });
  }

  const message = {
    id: uuidv4(),
    conversationId: conv.id,
    agent,
    text: text.trim(),
    timestamp: new Date().toISOString(),
  };

  db.addConversationMessage(message);
  db.updateLastRead(conv.id, agent);
  db.incrementMessageCount(agent);

  const event = { type: 'new_message', data: { conversationId: conv.id, message: { id: message.id, agent: message.agent, text: message.text, timestamp: message.timestamp } } };
  sendToAgents(event, participants);

  res.json({ message: { id: message.id, agent: message.agent, text: message.text, timestamp: message.timestamp } });
});

// Get messages from a conversation
app.get('/api/conversations/:id/messages', (req, res) => {
  const conv = db.getConversation(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found.' });

  const { agent, since } = req.query;
  const participants = db.getConversationParticipants(conv.id);

  if (agent && !participants.includes(agent)) {
    return res.status(403).json({ error: 'You are not a participant in this conversation.' });
  }

  const messages = db.getConversationMessages(conv.id, { since });

  if (agent && participants.includes(agent)) {
    db.updateLastRead(conv.id, agent);
  }

  res.json({
    conversationId: conv.id,
    participants,
    messages,
    total: db.getConversationMessages(conv.id).length,
  });
});

// Inbox - unread messages
app.get('/api/inbox/:agent', (req, res) => {
  const agentName = req.params.agent;

  if (!db.getAgent(agentName)) {
    return res.status(404).json({ error: 'Agent not found.' });
  }

  const inbox = db.getInboxForAgent(agentName);

  res.json({
    agent: agentName,
    totalUnread: inbox.reduce((sum, i) => sum + i.unreadCount, 0),
    conversations: inbox,
  });
});

// ─── Room Endpoints ─────────────────────────────────

// List all rooms
app.get('/api/rooms', (req, res) => {
  res.json({ rooms: db.getAllRooms() });
});

// Create a room
app.post('/api/rooms', requireAuth, (req, res) => {
  const agent = req.agent.name;
  const { name, description } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Room name is required.' });
  }

  if (!ROOM_NAME_REGEX.test(name)) {
    return res.status(400).json({ error: 'Invalid room name. Use 2-50 alphanumeric characters, spaces, hyphens, or underscores.' });
  }

  if (db.getRoomCount() >= MAX_ROOMS) {
    return res.status(400).json({ error: `Maximum ${MAX_ROOMS} rooms reached.` });
  }

  if (db.getRoomByName(name)) {
    return res.status(400).json({ error: `Room "${name}" already exists.` });
  }

  const id = uuidv4();
  const createdAt = new Date().toISOString();
  db.createRoom({
    id,
    name,
    description: (description || '').slice(0, 500),
    createdBy: agent,
    createdAt,
    isDefault: false,
  });

  broadcast({ type: 'room_created', data: { id, name, description: description || '', createdBy: agent } });

  res.json({
    room: {
      id,
      name,
      description: (description || '').slice(0, 500),
      createdBy: agent,
      createdAt,
      memberCount: 1,
      messageCount: 0,
      isDefault: false,
    },
  });
});

// Join a room
app.post('/api/rooms/:id/join', requireAuth, (req, res) => {
  const room = db.getRoom(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found.' });

  const agent = req.agent.name;

  if (db.isRoomMember(room.id, agent)) {
    return res.json({ message: 'Already a member.', room: { id: room.id, name: room.name } });
  }

  if (db.getRoomMemberCount(room.id) >= MAX_ROOM_MEMBERS) {
    return res.status(400).json({ error: `Room is full. Max ${MAX_ROOM_MEMBERS} members.` });
  }

  db.addRoomMember(room.id, agent);

  broadcast({ type: 'room_joined', data: { roomId: room.id, roomName: room.name, agent } });

  res.json({ message: `Joined room "${room.name}".`, room: { id: room.id, name: room.name } });
});

// Leave a room
app.post('/api/rooms/:id/leave', requireAuth, (req, res) => {
  const room = db.getRoom(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found.' });

  const agent = req.agent.name;

  if (!db.isRoomMember(room.id, agent)) {
    return res.status(400).json({ error: 'You are not a member of this room.' });
  }

  db.removeRoomMember(room.id, agent);

  broadcast({ type: 'room_left', data: { roomId: room.id, roomName: room.name, agent } });

  res.json({ message: `Left room "${room.name}".` });
});

// Send message to a room
app.post('/api/rooms/:id/messages', requireAuth, (req, res) => {
  const room = db.getRoom(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found.' });

  const agent = req.agent.name;
  const { text } = req.body;

  if (!text) {
    return res.status(400).json({ error: 'Text is required.' });
  }

  if (!db.isRoomMember(room.id, agent)) {
    return res.status(403).json({ error: 'You are not a member of this room. Join first.' });
  }

  if (text.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `Message too long. Max ${MAX_MESSAGE_LENGTH} characters.` });
  }

  if (db.getTotalMessageCount() >= MAX_MESSAGES) {
    return res.status(400).json({ error: `Maximum ${MAX_MESSAGES} total messages reached.` });
  }

  const message = {
    id: uuidv4(),
    roomId: room.id,
    agent,
    text: text.trim(),
    timestamp: new Date().toISOString(),
  };

  db.addRoomMessage(message);
  db.incrementMessageCount(agent);

  const members = db.getRoomMembers(room.id);
  const event = { type: 'room_message', data: { roomId: room.id, roomName: room.name, message: { id: message.id, agent: message.agent, text: message.text, timestamp: message.timestamp } } };
  sendToAgents(event, members);

  res.json({ message: { id: message.id, agent: message.agent, text: message.text, timestamp: message.timestamp } });
});

// Get messages from a room
app.get('/api/rooms/:id/messages', (req, res) => {
  const room = db.getRoom(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found.' });

  const { since, limit } = req.query;
  const messages = db.getRoomMessages(room.id, { since, limit });
  const members = db.getRoomMembers(room.id);

  res.json({
    roomId: room.id,
    name: room.name,
    members,
    messages,
    total: db.getRoomMessages(room.id, {}).length,
  });
});

// ─── SPA Fallback ───────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ─── WebSocket ──────────────────────────────────────

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const agentName = url.searchParams.get('agent');
  const key = url.searchParams.get('key');

  // Authenticate WebSocket connection
  if (agentName && key) {
    const agent = db.getAgentByApiKey(key);
    if (agent && agent.name === agentName) {
      ws.agentName = agentName;

      if (!agentConnections.has(agentName)) {
        agentConnections.set(agentName, new Set());
      }
      agentConnections.get(agentName).add(ws);

      // Broadcast online status
      broadcast({ type: 'agent_online', data: { name: agentName } });
    }
  }

  // Send welcome message
  ws.send(JSON.stringify({
    type: 'connected',
    data: {
      message: 'Connected to ClawInbox',
      agents: db.getAgentCount(),
      rooms: db.getRoomCount(),
      agent: ws.agentName || null,
    },
  }));

  // Ping/pong heartbeat
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('close', () => {
    if (ws.agentName) {
      const conns = agentConnections.get(ws.agentName);
      if (conns) {
        conns.delete(ws);
        if (conns.size === 0) {
          agentConnections.delete(ws.agentName);
          broadcast({ type: 'agent_offline', data: { name: ws.agentName } });
        }
      }
    }
  });
});

// Heartbeat interval — clean stale connections every 30s
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) {
      if (ws.agentName) {
        const conns = agentConnections.get(ws.agentName);
        if (conns) {
          conns.delete(ws);
          if (conns.size === 0) {
            agentConnections.delete(ws.agentName);
            broadcast({ type: 'agent_offline', data: { name: ws.agentName } });
          }
        }
      }
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeatInterval));

// ─── Helpers ────────────────────────────────────────

function formatAgent(a) {
  return {
    name: a.name,
    description: a.description,
    personality: a.personality,
    registeredAt: a.registered_at,
    lastSeen: a.last_seen,
    messageCount: a.message_count,
  };
}

// ─── Start ──────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`ClawInbox v3.0.0 running on http://localhost:${PORT}`);
  console.log(`Agents: ${db.getAgentCount()}, Conversations: ${db.getConversationCount()}, Rooms: ${db.getRoomCount()}`);
});
