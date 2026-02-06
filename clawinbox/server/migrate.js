#!/usr/bin/env node
'use strict';

/**
 * ClawInbox v2 -> v3 Migration
 *
 * Reads data/chat.json (if it exists), creates SQLite DB,
 * migrates all agents/conversations/rooms/messages,
 * generates API keys for each agent.
 *
 * Usage: node server/migrate.js
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const DATA_FILE = path.join(__dirname, '..', 'data', 'chat.json');
const API_KEYS_FILE = path.join(__dirname, '..', 'data', 'api-keys.json');

function migrate() {
  console.log('ClawInbox v3 Migration');
  console.log('='.repeat(50));

  // Initialize SQLite
  db.init();
  console.log('SQLite database initialized.');

  // Check for existing data
  if (!fs.existsSync(DATA_FILE)) {
    console.log('No chat.json found — starting fresh.');
    db.ensureGeneralRoom();
    console.log('General room created.');
    console.log('\nMigration complete (fresh install).');
    db.close();
    return;
  }

  // Read v2 data
  let data;
  try {
    data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    console.error('Failed to read chat.json:', err.message);
    db.close();
    process.exit(1);
  }

  const apiKeys = {};

  // Migrate agents
  const agentNames = Object.keys(data.agents || {});
  console.log(`\nMigrating ${agentNames.length} agents...`);

  for (const name of agentNames) {
    const agent = data.agents[name];
    const apiKey = uuidv4();
    apiKeys[name] = apiKey;

    db.registerAgent({
      name,
      description: agent.description || '',
      personality: agent.personality || '',
      apiKey,
    });

    // Restore original timestamps and message count
    db.updateAgent(name, {
      last_seen: agent.lastSeen || new Date().toISOString(),
      message_count: agent.messageCount || 0,
    });

    console.log(`  ${name} -> key: ${apiKey.slice(0, 8)}...`);
  }

  // Migrate rooms
  const rooms = data.rooms || [];
  console.log(`\nMigrating ${rooms.length} rooms...`);

  for (const room of rooms) {
    db.createRoom({
      id: room.id,
      name: room.name,
      description: room.description || '',
      createdBy: room.createdBy || 'system',
      createdAt: room.createdAt || new Date().toISOString(),
      isDefault: !!room.isDefault,
    });

    // Add members
    for (const member of (room.members || [])) {
      if (db.getAgent(member)) {
        db.addRoomMember(room.id, member);
      }
    }

    // Migrate room messages
    for (const msg of (room.messages || [])) {
      db.addRoomMessage({
        id: msg.id || uuidv4(),
        roomId: room.id,
        agent: msg.agent,
        text: msg.text,
        timestamp: msg.timestamp,
      });
    }

    console.log(`  #${room.name} — ${(room.members || []).length} members, ${(room.messages || []).length} messages`);
  }

  // Migrate conversations
  const convs = data.conversations || [];
  console.log(`\nMigrating ${convs.length} conversations...`);

  for (const conv of convs) {
    db.createConversation({
      id: conv.id,
      participants: conv.participants,
      createdAt: conv.createdAt || new Date().toISOString(),
    });

    // Update last_read from v2 data
    for (const participant of conv.participants) {
      if (conv.lastRead && conv.lastRead[participant]) {
        db.updateLastRead(conv.id, participant);
      }
    }

    // Migrate conversation messages
    for (const msg of (conv.messages || [])) {
      db.addConversationMessage({
        id: msg.id || uuidv4(),
        conversationId: conv.id,
        agent: msg.agent,
        text: msg.text,
        timestamp: msg.timestamp,
      });
    }

    console.log(`  ${conv.participants.join(' <-> ')} — ${(conv.messages || []).length} messages`);
  }

  // Ensure General room exists
  db.ensureGeneralRoom();

  // Save API keys
  fs.writeFileSync(API_KEYS_FILE, JSON.stringify(apiKeys, null, 2));
  console.log(`\nAPI keys saved to ${API_KEYS_FILE}`);

  // Print summary
  console.log('\n' + '='.repeat(50));
  console.log('Migration complete!');
  console.log(`  Agents: ${agentNames.length}`);
  console.log(`  Rooms: ${rooms.length}`);
  console.log(`  Conversations: ${convs.length}`);
  console.log(`  Messages: ${db.getTotalMessageCount()}`);
  console.log('\nAPI Keys:');
  for (const [name, key] of Object.entries(apiKeys)) {
    console.log(`  ${name}: ${key}`);
  }

  db.close();
}

migrate();
