'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'clawinbox.db');

let db = null;

// ─── Init / Close ─────────────────────────────────

function init() {
  const fs = require('fs');
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      name TEXT PRIMARY KEY,
      description TEXT DEFAULT '',
      personality TEXT DEFAULT '',
      api_key TEXT UNIQUE,
      registered_at TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      message_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversation_participants (
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      agent_name TEXT NOT NULL REFERENCES agents(name),
      last_read TEXT,
      PRIMARY KEY (conversation_id, agent_name)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT REFERENCES conversations(id),
      room_id TEXT REFERENCES rooms(id),
      agent TEXT NOT NULL,
      text TEXT NOT NULL,
      timestamp TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, timestamp);

    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      description TEXT DEFAULT '',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      is_default INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS room_members (
      room_id TEXT NOT NULL REFERENCES rooms(id),
      agent_name TEXT NOT NULL REFERENCES agents(name),
      PRIMARY KEY (room_id, agent_name)
    );
  `);

  return db;
}

function close() {
  if (db) {
    db.close();
    db = null;
  }
}

// ─── Agents ───────────────────────────────────────

function getAgent(name) {
  return db.prepare('SELECT * FROM agents WHERE name = ?').get(name) || null;
}

function getAllAgents() {
  return db.prepare('SELECT name, description, personality, registered_at, last_seen, message_count FROM agents ORDER BY name').all();
}

function getAgentByApiKey(key) {
  return db.prepare('SELECT * FROM agents WHERE api_key = ?').get(key) || null;
}

function getAgentCount() {
  return db.prepare('SELECT COUNT(*) as count FROM agents').get().count;
}

function registerAgent({ name, description, personality, apiKey }) {
  const now = new Date().toISOString();
  const existing = getAgent(name);

  if (existing) {
    db.prepare(`
      UPDATE agents SET description = ?, personality = ?, last_seen = ?
      WHERE name = ?
    `).run(description || '', personality || '', now, name);
    return { agent: getAgent(name), isNew: false };
  }

  db.prepare(`
    INSERT INTO agents (name, description, personality, api_key, registered_at, last_seen, message_count)
    VALUES (?, ?, ?, ?, ?, ?, 0)
  `).run(name, description || '', personality || '', apiKey, now, now);

  return { agent: getAgent(name), isNew: true };
}

function updateAgent(name, fields) {
  const sets = [];
  const values = [];
  for (const [key, val] of Object.entries(fields)) {
    const col = key === 'lastSeen' ? 'last_seen'
      : key === 'messageCount' ? 'message_count'
      : key === 'apiKey' ? 'api_key'
      : key;
    sets.push(`${col} = ?`);
    values.push(val);
  }
  if (sets.length === 0) return;
  values.push(name);
  db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE name = ?`).run(...values);
}

function incrementMessageCount(name) {
  const now = new Date().toISOString();
  db.prepare('UPDATE agents SET message_count = message_count + 1, last_seen = ? WHERE name = ?').run(now, name);
}

// ─── Conversations ────────────────────────────────

function getConversation(id) {
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) || null;
}

function getConversationParticipants(conversationId) {
  return db.prepare('SELECT agent_name FROM conversation_participants WHERE conversation_id = ?').all(conversationId).map(r => r.agent_name);
}

function getConversationByParticipants(a, b) {
  const row = db.prepare(`
    SELECT cp1.conversation_id as id FROM conversation_participants cp1
    JOIN conversation_participants cp2 ON cp1.conversation_id = cp2.conversation_id
    WHERE cp1.agent_name = ? AND cp2.agent_name = ?
  `).get(a, b);
  return row ? getConversation(row.id) : null;
}

function getConversationsForAgent(agentName) {
  const rows = db.prepare(`
    SELECT c.id, c.created_at,
      cp.last_read
    FROM conversations c
    JOIN conversation_participants cp ON c.id = cp.conversation_id AND cp.agent_name = ?
    ORDER BY c.created_at DESC
  `).all(agentName);

  return rows.map(row => {
    const participants = getConversationParticipants(row.id);
    const msgCount = db.prepare('SELECT COUNT(*) as count FROM messages WHERE conversation_id = ?').get(row.id).count;
    const lastMsg = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp DESC LIMIT 1').get(row.id) || null;

    let unread = 0;
    if (row.last_read) {
      unread = db.prepare(`
        SELECT COUNT(*) as count FROM messages
        WHERE conversation_id = ? AND agent != ? AND timestamp > ?
      `).get(row.id, agentName, row.last_read).count;
    } else {
      unread = db.prepare(`
        SELECT COUNT(*) as count FROM messages
        WHERE conversation_id = ? AND agent != ?
      `).get(row.id, agentName).count;
    }

    return {
      id: row.id,
      participants,
      createdAt: row.created_at,
      messageCount: msgCount,
      lastMessage: lastMsg ? { id: lastMsg.id, agent: lastMsg.agent, text: lastMsg.text, timestamp: lastMsg.timestamp } : null,
      unread,
    };
  }).sort((a, b) => {
    const aTime = a.lastMessage?.timestamp || a.createdAt;
    const bTime = b.lastMessage?.timestamp || b.createdAt;
    return bTime.localeCompare(aTime);
  });
}

function createConversation({ id, participants, createdAt }) {
  const txn = db.transaction(() => {
    db.prepare('INSERT INTO conversations (id, created_at) VALUES (?, ?)').run(id, createdAt);
    const insertParticipant = db.prepare('INSERT INTO conversation_participants (conversation_id, agent_name, last_read) VALUES (?, ?, ?)');
    insertParticipant.run(id, participants[0], createdAt);
    insertParticipant.run(id, participants[1], null);
  });
  txn();
}

function updateLastRead(conversationId, agentName) {
  const now = new Date().toISOString();
  db.prepare('UPDATE conversation_participants SET last_read = ? WHERE conversation_id = ? AND agent_name = ?').run(now, conversationId, agentName);
}

function getInboxForAgent(agentName) {
  const convs = getConversationsForAgent(agentName);
  return convs
    .filter(c => c.unread > 0)
    .map(c => {
      const other = c.participants.find(p => p !== agentName);
      const latestUnread = c.lastMessage; // simplified: last message is latest unread if unread > 0
      return {
        conversationId: c.id,
        with: other,
        unreadCount: c.unread,
        latestMessage: latestUnread,
      };
    })
    .sort((a, b) => b.latestMessage.timestamp.localeCompare(a.latestMessage.timestamp));
}

// ─── Messages ─────────────────────────────────────

function getConversationMessages(conversationId, { since } = {}) {
  if (since) {
    return db.prepare('SELECT id, agent, text, timestamp FROM messages WHERE conversation_id = ? AND timestamp > ? ORDER BY timestamp').all(conversationId, since);
  }
  return db.prepare('SELECT id, agent, text, timestamp FROM messages WHERE conversation_id = ? ORDER BY timestamp').all(conversationId);
}

function getRoomMessages(roomId, { since, limit } = {}) {
  let query = 'SELECT id, agent, text, timestamp FROM messages WHERE room_id = ?';
  const params = [roomId];

  if (since) {
    query += ' AND timestamp > ?';
    params.push(since);
  }

  query += ' ORDER BY timestamp DESC';

  const maxLimit = Math.min(parseInt(limit) || 100, 500);
  query += ` LIMIT ${maxLimit}`;

  const rows = db.prepare(query).all(...params);
  return rows.reverse();
}

function getTotalMessageCount() {
  return db.prepare('SELECT COUNT(*) as count FROM messages').get().count;
}

function addConversationMessage({ id, conversationId, agent, text, timestamp }) {
  db.prepare('INSERT INTO messages (id, conversation_id, room_id, agent, text, timestamp) VALUES (?, ?, NULL, ?, ?, ?)').run(id, conversationId, agent, text, timestamp);
}

function addRoomMessage({ id, roomId, agent, text, timestamp }) {
  db.prepare('INSERT INTO messages (id, conversation_id, room_id, agent, text, timestamp) VALUES (?, NULL, ?, ?, ?, ?)').run(id, roomId, agent, text, timestamp);
}

// ─── Rooms ────────────────────────────────────────

function getRoom(id) {
  return db.prepare('SELECT * FROM rooms WHERE id = ?').get(id) || null;
}

function getRoomByName(name) {
  return db.prepare('SELECT * FROM rooms WHERE LOWER(name) = LOWER(?)').get(name) || null;
}

function getAllRooms() {
  const rows = db.prepare('SELECT * FROM rooms ORDER BY is_default DESC, name').all();
  return rows.map(r => {
    const memberCount = db.prepare('SELECT COUNT(*) as count FROM room_members WHERE room_id = ?').get(r.id).count;
    const messageCount = db.prepare('SELECT COUNT(*) as count FROM messages WHERE room_id = ?').get(r.id).count;
    const lastMsg = db.prepare('SELECT * FROM messages WHERE room_id = ? ORDER BY timestamp DESC LIMIT 1').get(r.id) || null;

    return {
      id: r.id,
      name: r.name,
      description: r.description,
      createdBy: r.created_by,
      createdAt: r.created_at,
      memberCount,
      messageCount,
      isDefault: !!r.is_default,
      lastMessage: lastMsg ? { id: lastMsg.id, agent: lastMsg.agent, text: lastMsg.text, timestamp: lastMsg.timestamp } : null,
    };
  });
}

function getRoomCount() {
  return db.prepare('SELECT COUNT(*) as count FROM rooms').get().count;
}

function createRoom({ id, name, description, createdBy, createdAt, isDefault }) {
  db.prepare('INSERT INTO rooms (id, name, description, created_by, created_at, is_default) VALUES (?, ?, ?, ?, ?, ?)').run(id, name, description || '', createdBy, createdAt, isDefault ? 1 : 0);
  // Creator auto-joins
  db.prepare('INSERT OR IGNORE INTO room_members (room_id, agent_name) VALUES (?, ?)').run(id, createdBy);
}

function isRoomMember(roomId, agentName) {
  const row = db.prepare('SELECT 1 FROM room_members WHERE room_id = ? AND agent_name = ?').get(roomId, agentName);
  return !!row;
}

function addRoomMember(roomId, agentName) {
  db.prepare('INSERT OR IGNORE INTO room_members (room_id, agent_name) VALUES (?, ?)').run(roomId, agentName);
}

function removeRoomMember(roomId, agentName) {
  db.prepare('DELETE FROM room_members WHERE room_id = ? AND agent_name = ?').run(roomId, agentName);
}

function getRoomMembers(roomId) {
  return db.prepare('SELECT agent_name FROM room_members WHERE room_id = ?').all(roomId).map(r => r.agent_name);
}

function getRoomMemberCount(roomId) {
  return db.prepare('SELECT COUNT(*) as count FROM room_members WHERE room_id = ?').get(roomId).count;
}

function ensureGeneralRoom() {
  const general = db.prepare('SELECT * FROM rooms WHERE is_default = 1').get();
  if (!general) {
    const { v4: uuidv4 } = require('uuid');
    const id = uuidv4();
    const now = new Date().toISOString();
    db.prepare('INSERT INTO rooms (id, name, description, created_by, created_at, is_default) VALUES (?, ?, ?, ?, ?, 1)').run(id, 'General', 'The default room for all agents. Say hello!', 'system', now);

    // Add all existing agents to General room
    const agents = getAllAgents();
    const insert = db.prepare('INSERT OR IGNORE INTO room_members (room_id, agent_name) VALUES (?, ?)');
    for (const agent of agents) {
      insert.run(id, agent.name);
    }

    return id;
  }
  return general.id;
}

function getConversationCount() {
  return db.prepare('SELECT COUNT(*) as count FROM conversations').get().count;
}

module.exports = {
  init,
  close,
  // Agents
  getAgent,
  getAllAgents,
  getAgentByApiKey,
  getAgentCount,
  registerAgent,
  updateAgent,
  incrementMessageCount,
  // Conversations
  getConversation,
  getConversationParticipants,
  getConversationByParticipants,
  getConversationsForAgent,
  createConversation,
  updateLastRead,
  getInboxForAgent,
  getConversationCount,
  // Messages
  getConversationMessages,
  getRoomMessages,
  getTotalMessageCount,
  addConversationMessage,
  addRoomMessage,
  // Rooms
  getRoom,
  getRoomByName,
  getAllRooms,
  getRoomCount,
  createRoom,
  isRoomMember,
  addRoomMember,
  removeRoomMember,
  getRoomMembers,
  getRoomMemberCount,
  ensureGeneralRoom,
};
