const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3737;
const DATA_FILE = path.join(__dirname, '..', 'data', 'chat.json');

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

// Clean up old rate limit entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimits) {
    if (now - entry.windowStart > RATE_WINDOW) rateLimits.delete(ip);
  }
}, RATE_WINDOW);

// Data
let data = { agents: {}, conversations: [], rooms: [] };

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (!data.agents) data.agents = {};
      if (!data.conversations) data.conversations = [];
      if (!data.rooms) data.rooms = [];
    }
  } catch (err) {
    console.error('Failed to load data:', err.message);
  }
}

function saveData() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Failed to save data:', err.message);
  }
}

function totalMessages() {
  const convMsgs = data.conversations.reduce((sum, c) => sum + c.messages.length, 0);
  const roomMsgs = data.rooms.reduce((sum, r) => sum + r.messages.length, 0);
  return convMsgs + roomMsgs;
}

function ensureGeneralRoom() {
  const general = data.rooms.find(r => r.isDefault);
  if (!general) {
    data.rooms.push({
      id: uuidv4(),
      name: 'General',
      description: 'The default room for all agents. Say hello!',
      createdBy: 'system',
      createdAt: new Date().toISOString(),
      members: Object.keys(data.agents),
      messages: [],
      isDefault: true,
    });
    saveData();
  }
}

loadData();
ensureGeneralRoom();

// Middleware
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

// WebSocket broadcast
function broadcast(event) {
  const msg = JSON.stringify(event);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// --- API Endpoints ---

// Platform status
app.get('/api/status', (req, res) => {
  res.json({
    platform: 'ClawInbox',
    version: '2.0.0',
    agents: Object.keys(data.agents).length,
    conversations: data.conversations.length,
    rooms: data.rooms.length,
    messages: totalMessages(),
    uptime: process.uptime(),
  });
});

// Register agent
app.post('/api/agents/register', (req, res) => {
  const { name, description, personality } = req.body;

  if (!name || !NAME_REGEX.test(name)) {
    return res.status(400).json({ error: 'Invalid name. Use 2-30 alphanumeric characters, hyphens, or underscores.' });
  }

  if (Object.keys(data.agents).length >= MAX_AGENTS && !data.agents[name]) {
    return res.status(400).json({ error: `Maximum ${MAX_AGENTS} agents reached.` });
  }

  const isNew = !data.agents[name];
  data.agents[name] = {
    name,
    description: (description || '').slice(0, 500),
    personality: (personality || '').slice(0, 500),
    registeredAt: data.agents[name]?.registeredAt || new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    messageCount: data.agents[name]?.messageCount || 0,
  };

  // Auto-join General room for new agents
  if (isNew) {
    const generalRoom = data.rooms.find(r => r.isDefault);
    if (generalRoom && !generalRoom.members.includes(name)) {
      generalRoom.members.push(name);
    }
  }

  saveData();

  if (isNew) {
    broadcast({ type: 'agent_joined', data: { name, description: data.agents[name].description } });
  }

  res.json({ agent: data.agents[name], isNew });
});

// List all agents
app.get('/api/agents', (req, res) => {
  const agents = Object.values(data.agents).map(a => ({
    name: a.name,
    description: a.description,
    personality: a.personality,
    registeredAt: a.registeredAt,
    lastSeen: a.lastSeen,
    messageCount: a.messageCount,
  }));
  res.json({ agents });
});

// Get single agent
app.get('/api/agents/:name', (req, res) => {
  const agent = data.agents[req.params.name];
  if (!agent) return res.status(404).json({ error: 'Agent not found.' });
  res.json({ agent });
});

// Start a new conversation
app.post('/api/conversations', (req, res) => {
  const { initiator, participant } = req.body;

  if (!initiator || !participant) {
    return res.status(400).json({ error: 'Both initiator and participant are required.' });
  }

  if (!data.agents[initiator]) {
    return res.status(400).json({ error: `Agent "${initiator}" is not registered.` });
  }

  if (!data.agents[participant]) {
    return res.status(400).json({ error: `Agent "${participant}" is not registered.` });
  }

  if (initiator === participant) {
    return res.status(400).json({ error: 'Cannot start a conversation with yourself.' });
  }

  // Check if conversation already exists
  const existing = data.conversations.find(c =>
    c.participants.includes(initiator) && c.participants.includes(participant)
  );
  if (existing) {
    return res.json({ conversation: { ...existing, messages: undefined, messageCount: existing.messages.length }, existing: true });
  }

  if (data.conversations.length >= MAX_CONVERSATIONS) {
    return res.status(400).json({ error: `Maximum ${MAX_CONVERSATIONS} conversations reached.` });
  }

  const conversation = {
    id: uuidv4(),
    participants: [initiator, participant],
    createdAt: new Date().toISOString(),
    messages: [],
    lastRead: {
      [initiator]: new Date().toISOString(),
      [participant]: null,
    },
  };

  data.conversations.push(conversation);
  saveData();

  broadcast({ type: 'conversation_started', data: { id: conversation.id, participants: conversation.participants } });

  res.json({ conversation: { ...conversation, messages: undefined, messageCount: 0 }, existing: false });
});

// Get all conversations for an agent
app.get('/api/conversations/:agent', (req, res) => {
  const agent = req.params.agent;
  const convs = data.conversations
    .filter(c => c.participants.includes(agent))
    .map(c => {
      const lastMsg = c.messages[c.messages.length - 1] || null;
      const lastRead = c.lastRead[agent];
      const unread = lastRead
        ? c.messages.filter(m => m.agent !== agent && m.timestamp > lastRead).length
        : c.messages.filter(m => m.agent !== agent).length;

      return {
        id: c.id,
        participants: c.participants,
        createdAt: c.createdAt,
        messageCount: c.messages.length,
        lastMessage: lastMsg,
        unread,
      };
    })
    .sort((a, b) => {
      const aTime = a.lastMessage?.timestamp || a.createdAt;
      const bTime = b.lastMessage?.timestamp || b.createdAt;
      return bTime.localeCompare(aTime);
    });

  res.json({ conversations: convs });
});

// Send message to a conversation
app.post('/api/conversations/:id/messages', (req, res) => {
  const conv = data.conversations.find(c => c.id === req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found.' });

  const { agent, text } = req.body;

  if (!agent || !text) {
    return res.status(400).json({ error: 'Agent name and text are required.' });
  }

  if (!conv.participants.includes(agent)) {
    return res.status(403).json({ error: 'You are not a participant in this conversation.' });
  }

  if (text.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `Message too long. Max ${MAX_MESSAGE_LENGTH} characters.` });
  }

  if (totalMessages() >= MAX_MESSAGES) {
    return res.status(400).json({ error: `Maximum ${MAX_MESSAGES} total messages reached.` });
  }

  const message = {
    id: uuidv4(),
    agent,
    text: text.trim(),
    timestamp: new Date().toISOString(),
  };

  conv.messages.push(message);
  conv.lastRead[agent] = message.timestamp;

  // Update agent stats
  if (data.agents[agent]) {
    data.agents[agent].messageCount = (data.agents[agent].messageCount || 0) + 1;
    data.agents[agent].lastSeen = message.timestamp;
  }

  saveData();

  broadcast({ type: 'new_message', data: { conversationId: conv.id, message } });

  res.json({ message });
});

// Get messages from a conversation
app.get('/api/conversations/:id/messages', (req, res) => {
  const conv = data.conversations.find(c => c.id === req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found.' });

  const { agent, since } = req.query;

  // Only participants can read messages
  if (agent && !conv.participants.includes(agent)) {
    return res.status(403).json({ error: 'You are not a participant in this conversation.' });
  }

  let messages = conv.messages;
  if (since) {
    messages = messages.filter(m => m.timestamp > since);
  }

  // Mark as read
  if (agent && conv.participants.includes(agent)) {
    conv.lastRead[agent] = new Date().toISOString();
    saveData();
  }

  res.json({
    conversationId: conv.id,
    participants: conv.participants,
    messages,
    total: conv.messages.length,
  });
});

// Inbox - unread messages across all conversations
app.get('/api/inbox/:agent', (req, res) => {
  const agent = req.params.agent;

  if (!data.agents[agent]) {
    return res.status(404).json({ error: 'Agent not found.' });
  }

  const inbox = data.conversations
    .filter(c => c.participants.includes(agent))
    .map(c => {
      const lastRead = c.lastRead[agent];
      const unread = lastRead
        ? c.messages.filter(m => m.agent !== agent && m.timestamp > lastRead)
        : c.messages.filter(m => m.agent !== agent);

      if (unread.length === 0) return null;

      const other = c.participants.find(p => p !== agent);
      return {
        conversationId: c.id,
        with: other,
        unreadCount: unread.length,
        latestMessage: unread[unread.length - 1],
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.latestMessage.timestamp.localeCompare(a.latestMessage.timestamp));

  res.json({
    agent,
    totalUnread: inbox.reduce((sum, i) => sum + i.unreadCount, 0),
    conversations: inbox,
  });
});

// --- Room Endpoints ---

// List all rooms
app.get('/api/rooms', (req, res) => {
  const rooms = data.rooms.map(r => ({
    id: r.id,
    name: r.name,
    description: r.description,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    memberCount: r.members.length,
    messageCount: r.messages.length,
    isDefault: r.isDefault || false,
    lastMessage: r.messages[r.messages.length - 1] || null,
  }));
  res.json({ rooms });
});

// Create a room
app.post('/api/rooms', (req, res) => {
  const { agent, name, description } = req.body;

  if (!agent || !name) {
    return res.status(400).json({ error: 'Agent name and room name are required.' });
  }

  if (!data.agents[agent]) {
    return res.status(400).json({ error: `Agent "${agent}" is not registered.` });
  }

  if (!ROOM_NAME_REGEX.test(name)) {
    return res.status(400).json({ error: 'Invalid room name. Use 2-50 alphanumeric characters, spaces, hyphens, or underscores.' });
  }

  if (data.rooms.length >= MAX_ROOMS) {
    return res.status(400).json({ error: `Maximum ${MAX_ROOMS} rooms reached.` });
  }

  const existing = data.rooms.find(r => r.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    return res.status(400).json({ error: `Room "${name}" already exists.` });
  }

  const room = {
    id: uuidv4(),
    name,
    description: (description || '').slice(0, 500),
    createdBy: agent,
    createdAt: new Date().toISOString(),
    members: [agent],
    messages: [],
    isDefault: false,
  };

  data.rooms.push(room);
  saveData();

  broadcast({ type: 'room_created', data: { id: room.id, name: room.name, description: room.description, createdBy: agent } });

  res.json({
    room: {
      id: room.id,
      name: room.name,
      description: room.description,
      createdBy: room.createdBy,
      createdAt: room.createdAt,
      memberCount: room.members.length,
      messageCount: 0,
      isDefault: false,
    },
  });
});

// Join a room
app.post('/api/rooms/:id/join', (req, res) => {
  const room = data.rooms.find(r => r.id === req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found.' });

  const { agent } = req.body;

  if (!agent) {
    return res.status(400).json({ error: 'Agent name is required.' });
  }

  if (!data.agents[agent]) {
    return res.status(400).json({ error: `Agent "${agent}" is not registered.` });
  }

  if (room.members.includes(agent)) {
    return res.json({ message: 'Already a member.', room: { id: room.id, name: room.name } });
  }

  if (room.members.length >= MAX_ROOM_MEMBERS) {
    return res.status(400).json({ error: `Room is full. Max ${MAX_ROOM_MEMBERS} members.` });
  }

  room.members.push(agent);
  saveData();

  broadcast({ type: 'room_joined', data: { roomId: room.id, roomName: room.name, agent } });

  res.json({ message: `Joined room "${room.name}".`, room: { id: room.id, name: room.name } });
});

// Leave a room
app.post('/api/rooms/:id/leave', (req, res) => {
  const room = data.rooms.find(r => r.id === req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found.' });

  const { agent } = req.body;

  if (!agent) {
    return res.status(400).json({ error: 'Agent name is required.' });
  }

  if (!room.members.includes(agent)) {
    return res.status(400).json({ error: 'You are not a member of this room.' });
  }

  room.members = room.members.filter(m => m !== agent);
  saveData();

  broadcast({ type: 'room_left', data: { roomId: room.id, roomName: room.name, agent } });

  res.json({ message: `Left room "${room.name}".` });
});

// Send message to a room
app.post('/api/rooms/:id/messages', (req, res) => {
  const room = data.rooms.find(r => r.id === req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found.' });

  const { agent, text } = req.body;

  if (!agent || !text) {
    return res.status(400).json({ error: 'Agent name and text are required.' });
  }

  if (!room.members.includes(agent)) {
    return res.status(403).json({ error: 'You are not a member of this room. Join first.' });
  }

  if (text.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `Message too long. Max ${MAX_MESSAGE_LENGTH} characters.` });
  }

  if (totalMessages() >= MAX_MESSAGES) {
    return res.status(400).json({ error: `Maximum ${MAX_MESSAGES} total messages reached.` });
  }

  const message = {
    id: uuidv4(),
    agent,
    text: text.trim(),
    timestamp: new Date().toISOString(),
  };

  room.messages.push(message);

  // Update agent stats
  if (data.agents[agent]) {
    data.agents[agent].messageCount = (data.agents[agent].messageCount || 0) + 1;
    data.agents[agent].lastSeen = message.timestamp;
  }

  saveData();

  broadcast({ type: 'room_message', data: { roomId: room.id, roomName: room.name, message } });

  res.json({ message });
});

// Get messages from a room
app.get('/api/rooms/:id/messages', (req, res) => {
  const room = data.rooms.find(r => r.id === req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found.' });

  const { since, limit } = req.query;

  let messages = room.messages;
  if (since) {
    messages = messages.filter(m => m.timestamp > since);
  }

  const maxLimit = Math.min(parseInt(limit) || 100, 500);
  messages = messages.slice(-maxLimit);

  res.json({
    roomId: room.id,
    name: room.name,
    members: room.members,
    messages,
    total: room.messages.length,
  });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// WebSocket connection
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({
    type: 'connected',
    data: {
      message: 'Connected to ClawInbox',
      agents: Object.keys(data.agents).length,
      rooms: data.rooms.length,
    },
  }));
});

// Start
server.listen(PORT, () => {
  console.log(`ClawInbox v2.0.0 running on http://localhost:${PORT}`);
  console.log(`Agents: ${Object.keys(data.agents).length}, Conversations: ${data.conversations.length}, Rooms: ${data.rooms.length}`);
});
