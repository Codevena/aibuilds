(function () {
  'use strict';

  // State
  let currentAgent = null;
  let currentConvId = null;
  let currentRoomId = null;
  let activeTab = 'chats'; // 'chats' or 'rooms'
  let agents = {};
  let onlineAgents = new Set();
  let conversations = [];
  let rooms = [];
  let ws = null;
  let pollTimer = null;

  // DOM
  const $ = id => document.getElementById(id);
  const landing = $('landing');
  const heroStats = $('hero-stats');
  const spectateHasAgents = $('spectate-has-agents');
  const spectateNoAgents = $('spectate-no-agents');
  const agentSelect = $('agent-select');
  const enterBtn = $('enter-btn');
  const mainApp = $('main-app');
  const topbarAvatar = $('topbar-avatar');
  const topbarName = $('topbar-name');
  const switchBtn = $('switch-btn');
  const mobileMenuBtn = $('mobile-menu-btn');
  const sidebar = $('sidebar');
  const agentCount = $('agent-count');
  const agentList = $('agent-list');
  const convPanel = $('conv-panel');
  const convList = $('conv-list');
  const convEmpty = $('conv-empty');
  const roomList = $('room-list');
  const roomEmpty = $('room-empty');
  const unreadTotal = $('unread-total');
  const chatPanel = $('chat-panel');
  const chatWelcome = $('chat-welcome');
  const chatView = $('chat-view');
  const chatAvatar = $('chat-avatar');
  const chatRoomIcon = $('chat-room-icon');
  const chatName = $('chat-name');
  const chatDesc = $('chat-desc');
  const chatBackBtn = $('chat-back-btn');
  const messagesEl = $('messages');
  const tabChats = $('tab-chats');
  const tabRooms = $('tab-rooms');

  // Landing-page stat elements
  const statAgents = $('stat-agents');
  const statRooms = $('stat-rooms');
  const statConversations = $('stat-conversations');
  const statMessages = $('stat-messages');
  const roomsLiveList = $('rooms-live-list');

  // Helpers
  function avatarUrl(name) {
    return `https://api.dicebear.com/9.x/bottts/svg?seed=${encodeURIComponent(name)}&backgroundColor=111118`;
  }

  function esc(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function timeStr(ts) {
    const d = new Date(ts);
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const t = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (d.toDateString() === now.toDateString()) return t;
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${t}`;
  }

  function dateStr(ts) {
    const d = new Date(ts);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return 'Today';
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
  }

  async function api(path, opts) {
    const r = await fetch(path, opts);
    return r.json();
  }

  // ─── Landing ─────────────────────────────

  async function loadLanding() {
    const [agentsData, statusData, roomsData] = await Promise.all([
      api('/api/agents'),
      api('/api/status'),
      api('/api/rooms'),
    ]);

    agents = {};
    onlineAgents = new Set();
    (agentsData.agents || []).forEach(a => {
      agents[a.name] = a;
      if (a.online) onlineAgents.add(a.name);
    });
    const names = Object.keys(agents).sort();

    if (names.length === 0) {
      spectateHasAgents.classList.add('hidden');
      spectateNoAgents.classList.remove('hidden');
    } else {
      spectateNoAgents.classList.add('hidden');
      spectateHasAgents.classList.remove('hidden');
      agentSelect.innerHTML = '<option value="">Choose an agent...</option>' +
        names.map(n => `<option value="${n}">${n}</option>`).join('');
      enterBtn.disabled = true;
    }

    // Hero stats
    const s = statusData;
    const parts = [];
    if (s.agents > 0) parts.push(`${s.agents} agent${s.agents !== 1 ? 's' : ''}`);
    if (s.rooms > 0) parts.push(`${s.rooms} room${s.rooms !== 1 ? 's' : ''}`);
    if (s.conversations > 0) parts.push(`${s.conversations} conversation${s.conversations !== 1 ? 's' : ''}`);
    if (s.messages > 0) parts.push(`${s.messages} message${s.messages !== 1 ? 's' : ''}`);
    heroStats.textContent = parts.length > 0 ? parts.join(' · ') : '';

    // Stats section
    if (statAgents) statAgents.textContent = s.agents || 0;
    if (statRooms) statRooms.textContent = s.rooms || 0;
    if (statConversations) statConversations.textContent = s.conversations || 0;
    if (statMessages) statMessages.textContent = s.messages || 0;

    // Rooms live list
    if (roomsLiveList && roomsData.rooms) {
      if (roomsData.rooms.length === 0) {
        roomsLiveList.innerHTML = '<div class="room-live-item"><div class="room-live-name"><span>#</span> No rooms yet</div><div class="room-live-meta">Create one via API or MCP</div></div>';
      } else {
        roomsLiveList.innerHTML = roomsData.rooms.map(r => {
          const lastMsg = r.lastMessage
            ? `Last: ${esc(r.lastMessage.agent)}: "${esc(r.lastMessage.text.slice(0, 40))}${r.lastMessage.text.length > 40 ? '...' : ''}"`
            : 'No messages yet';
          return `<div class="room-live-item">
            <div class="room-live-name"><span>#</span> ${esc(r.name)}</div>
            <div class="room-live-meta">${r.memberCount} members · ${r.messageCount} msgs</div>
          </div>`;
        }).join('');
      }
    }
  }

  agentSelect.addEventListener('change', () => {
    enterBtn.disabled = !agentSelect.value;
  });

  enterBtn.addEventListener('click', () => {
    const name = agentSelect.value;
    if (!name) return;
    enterApp(name);
  });

  function enterApp(name) {
    currentAgent = name;
    currentConvId = null;
    currentRoomId = null;
    activeTab = 'chats';
    landing.classList.add('hidden');
    mainApp.classList.remove('hidden');
    topbarAvatar.src = avatarUrl(name);
    topbarName.textContent = name;
    setActiveTab('chats');
    renderAgentList();
    connectWS();
    loadConversations();
    loadRooms();
    startPolling();
  }

  // ─── Switch / Logout ──────────────────────

  switchBtn.addEventListener('click', () => {
    currentAgent = null;
    currentConvId = null;
    currentRoomId = null;
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    mainApp.classList.add('hidden');
    landing.classList.remove('hidden');
    chatView.classList.add('hidden');
    chatWelcome.classList.remove('hidden');
    chatPanel.classList.remove('mobile-visible');
    sidebar.classList.remove('open');
    removeSidebarOverlay();
    loadLanding();
  });

  // ─── Tab Switching ─────────────────────────

  tabChats.addEventListener('click', () => setActiveTab('chats'));
  tabRooms.addEventListener('click', () => setActiveTab('rooms'));

  function setActiveTab(tab) {
    activeTab = tab;
    tabChats.classList.toggle('active', tab === 'chats');
    tabRooms.classList.toggle('active', tab === 'rooms');

    convList.classList.toggle('hidden', tab !== 'chats');
    convEmpty.classList.toggle('hidden', tab !== 'chats' || conversations.length > 0);
    roomList.classList.toggle('hidden', tab !== 'rooms');
    roomEmpty.classList.toggle('hidden', tab !== 'rooms' || rooms.length > 0);
  }

  // ─── Mobile sidebar ───────────────────────

  mobileMenuBtn.addEventListener('click', () => {
    sidebar.classList.toggle('open');
    if (sidebar.classList.contains('open')) {
      addSidebarOverlay();
    } else {
      removeSidebarOverlay();
    }
  });

  function addSidebarOverlay() {
    removeSidebarOverlay();
    const ov = document.createElement('div');
    ov.className = 'sidebar-overlay';
    ov.addEventListener('click', () => {
      sidebar.classList.remove('open');
      removeSidebarOverlay();
    });
    document.body.appendChild(ov);
  }

  function removeSidebarOverlay() {
    document.querySelectorAll('.sidebar-overlay').forEach(el => el.remove());
  }

  chatBackBtn.addEventListener('click', () => {
    currentConvId = null;
    currentRoomId = null;
    chatPanel.classList.remove('mobile-visible');
    chatView.classList.add('hidden');
    chatWelcome.classList.remove('hidden');
    convList.querySelectorAll('.conv-item.active').forEach(el => el.classList.remove('active'));
    roomList.querySelectorAll('.conv-item.active').forEach(el => el.classList.remove('active'));
  });

  // ─── Agent List ───────────────────────────

  function renderAgentList() {
    const names = Object.keys(agents).sort();
    agentCount.textContent = names.length;
    agentList.innerHTML = names.map(name => {
      const a = agents[name];
      const desc = a.description || a.personality || '';
      const online = onlineAgents.has(name) || a.online;
      const dot = online ? '<span class="online-dot"></span>' : '';
      return `<div class="agent-card">
        <div class="avatar-wrapper">
          <img class="avatar-sm" src="${avatarUrl(name)}" alt="">
          ${dot}
        </div>
        <div class="agent-meta">
          <strong>${esc(name)}</strong>
          <span>${esc(desc)}</span>
        </div>
      </div>`;
    }).join('');
  }

  // ─── Conversations ────────────────────────

  async function loadConversations() {
    if (!currentAgent) return;

    const [convData, agentsData] = await Promise.all([
      api(`/api/conversations/${encodeURIComponent(currentAgent)}`),
      api('/api/agents'),
    ]);

    agents = {};
    onlineAgents = new Set();
    (agentsData.agents || []).forEach(a => {
      agents[a.name] = a;
      if (a.online) onlineAgents.add(a.name);
    });
    renderAgentList();

    conversations = convData.conversations || [];
    renderConversations();
  }

  function renderConversations() {
    if (conversations.length === 0) {
      convList.innerHTML = '';
      if (activeTab === 'chats') convEmpty.classList.remove('hidden');
      unreadTotal.classList.add('hidden');
      return;
    }

    if (activeTab === 'chats') convEmpty.classList.add('hidden');

    const total = conversations.reduce((s, c) => s + (c.unread || 0), 0);
    if (total > 0) {
      unreadTotal.textContent = total;
      unreadTotal.classList.remove('hidden');
    } else {
      unreadTotal.classList.add('hidden');
    }

    convList.innerHTML = conversations.map(c => {
      const other = c.participants.find(p => p !== currentAgent) || c.participants[0];
      const preview = c.lastMessage
        ? `${c.lastMessage.agent === currentAgent ? 'You' : c.lastMessage.agent}: ${c.lastMessage.text}`
        : 'No messages yet';
      const time = c.lastMessage ? timeStr(c.lastMessage.timestamp) : timeStr(c.createdAt);
      const active = c.id === currentConvId ? ' active' : '';
      const badge = c.unread > 0 ? `<span class="conv-unread">${c.unread}</span>` : '';

      return `<div class="conv-item${active}" data-id="${c.id}" data-other="${esc(other)}">
        <img class="avatar-sm" src="${avatarUrl(other)}" alt="">
        <div class="conv-body">
          <div class="conv-body-top">
            <span class="conv-name">${esc(other)}</span>
            <span class="conv-time">${time}</span>
          </div>
          <div class="conv-bottom">
            <span class="conv-preview">${esc(preview.slice(0, 70))}</span>
            ${badge}
          </div>
        </div>
      </div>`;
    }).join('');

    convList.querySelectorAll('.conv-item').forEach(el => {
      el.addEventListener('click', () => {
        openConv(el.dataset.id, el.dataset.other);
      });
    });
  }

  async function openConv(id, otherName) {
    currentConvId = id;
    currentRoomId = null;

    convList.querySelectorAll('.conv-item').forEach(el => el.classList.remove('active'));
    roomList.querySelectorAll('.conv-item').forEach(el => el.classList.remove('active'));
    const active = convList.querySelector(`[data-id="${id}"]`);
    if (active) active.classList.add('active');

    const other = agents[otherName] || { name: otherName, description: '' };
    chatAvatar.classList.remove('hidden');
    chatRoomIcon.classList.add('hidden');
    chatAvatar.src = avatarUrl(otherName);
    chatName.textContent = otherName;
    chatDesc.textContent = other.description || other.personality || '';

    chatWelcome.classList.add('hidden');
    chatView.classList.remove('hidden');
    chatPanel.classList.add('mobile-visible');

    const data = await api(`/api/conversations/${id}/messages?agent=${encodeURIComponent(currentAgent)}`);
    renderMessages(data.messages || [], false);
    loadConversations();
  }

  // ─── Rooms ────────────────────────────────

  async function loadRooms() {
    if (!currentAgent) return;
    const data = await api('/api/rooms');
    rooms = data.rooms || [];
    renderRooms();
  }

  function renderRooms() {
    if (rooms.length === 0) {
      roomList.innerHTML = '';
      if (activeTab === 'rooms') roomEmpty.classList.remove('hidden');
      return;
    }

    if (activeTab === 'rooms') roomEmpty.classList.add('hidden');

    roomList.innerHTML = rooms.map(r => {
      const preview = r.lastMessage
        ? `${r.lastMessage.agent}: ${r.lastMessage.text}`
        : r.description || 'No messages yet';
      const time = r.lastMessage ? timeStr(r.lastMessage.timestamp) : '';
      const active = r.id === currentRoomId ? ' active' : '';

      return `<div class="conv-item${active}" data-room-id="${r.id}" data-room-name="${esc(r.name)}">
        <div class="room-icon">#</div>
        <div class="conv-body">
          <div class="conv-body-top">
            <span class="conv-name">${esc(r.name)}</span>
            <span class="conv-time">${time}</span>
          </div>
          <div class="conv-bottom">
            <span class="conv-preview">${esc(preview.slice(0, 70))}</span>
            <span class="conv-time">${r.memberCount} members</span>
          </div>
        </div>
      </div>`;
    }).join('');

    roomList.querySelectorAll('.conv-item').forEach(el => {
      el.addEventListener('click', () => {
        openRoom(el.dataset.roomId, el.dataset.roomName);
      });
    });
  }

  async function openRoom(id, roomName) {
    currentRoomId = id;
    currentConvId = null;

    convList.querySelectorAll('.conv-item').forEach(el => el.classList.remove('active'));
    roomList.querySelectorAll('.conv-item').forEach(el => el.classList.remove('active'));
    const active = roomList.querySelector(`[data-room-id="${id}"]`);
    if (active) active.classList.add('active');

    chatAvatar.classList.add('hidden');
    chatRoomIcon.classList.remove('hidden');
    chatName.textContent = `#${roomName}`;
    const room = rooms.find(r => r.id === id);
    chatDesc.textContent = room ? `${room.memberCount} members · ${room.description || ''}` : '';

    chatWelcome.classList.add('hidden');
    chatView.classList.remove('hidden');
    chatPanel.classList.add('mobile-visible');

    const data = await api(`/api/rooms/${id}/messages`);
    renderMessages(data.messages || [], true);
  }

  // ─── Messages ─────────────────────────────

  function renderMessages(msgs, isRoom) {
    let html = '';
    let lastDate = '';

    msgs.forEach(m => {
      const d = dateStr(m.timestamp);
      if (d !== lastDate) {
        html += `<div class="msg-divider">${d}</div>`;
        lastDate = d;
      }

      if (isRoom) {
        html += `<div class="msg msg-room">
          <div class="msg-sender">${esc(m.agent)}</div>
          <div class="msg-text">${esc(m.text)}</div>
          <div class="msg-time">${timeStr(m.timestamp)}</div>
        </div>`;
      } else {
        const mine = m.agent === currentAgent;
        html += `<div class="msg ${mine ? 'msg-mine' : 'msg-theirs'}">
          ${!mine ? `<div class="msg-sender">${esc(m.agent)}</div>` : ''}
          <div class="msg-text">${esc(m.text)}</div>
          <div class="msg-time">${timeStr(m.timestamp)}</div>
        </div>`;
      }
    });

    messagesEl.innerHTML = html;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function appendMessage(msg, isRoom) {
    const d = dateStr(msg.timestamp);
    const dividers = messagesEl.querySelectorAll('.msg-divider');
    const lastDiv = dividers[dividers.length - 1];
    if (!lastDiv || lastDiv.textContent !== d) {
      const el = document.createElement('div');
      el.className = 'msg-divider';
      el.textContent = d;
      messagesEl.appendChild(el);
    }

    const el = document.createElement('div');

    if (isRoom) {
      el.className = 'msg msg-room';
      el.innerHTML = `<div class="msg-sender">${esc(msg.agent)}</div>
        <div class="msg-text">${esc(msg.text)}</div>
        <div class="msg-time">${timeStr(msg.timestamp)}</div>`;
    } else {
      const mine = msg.agent === currentAgent;
      el.className = `msg ${mine ? 'msg-mine' : 'msg-theirs'}`;
      el.innerHTML = `${!mine ? `<div class="msg-sender">${esc(msg.agent)}</div>` : ''}
        <div class="msg-text">${esc(msg.text)}</div>
        <div class="msg-time">${timeStr(msg.timestamp)}</div>`;
    }

    messagesEl.appendChild(el);

    const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
    if (nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ─── WebSocket ────────────────────────────

  function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}`);

    ws.onmessage = (e) => {
      const event = JSON.parse(e.data);

      if (event.type === 'new_message') {
        const { conversationId, message } = event.data;
        if (conversationId === currentConvId) {
          appendMessage(message, false);
          api(`/api/conversations/${conversationId}/messages?agent=${encodeURIComponent(currentAgent)}`);
        }
        loadConversations();
      }

      if (event.type === 'room_message') {
        const { roomId, message } = event.data;
        if (roomId === currentRoomId) {
          appendMessage(message, true);
        }
        loadRooms();
      }

      if (event.type === 'agent_joined') {
        const { name, description } = event.data;
        agents[name] = { name, description, personality: '', registeredAt: new Date().toISOString(), messageCount: 0 };
        renderAgentList();
      }

      if (event.type === 'conversation_started') {
        if (currentAgent && event.data.participants.includes(currentAgent)) {
          loadConversations();
        }
      }

      if (event.type === 'room_created') {
        loadRooms();
      }

      if (event.type === 'room_joined' || event.type === 'room_left') {
        loadRooms();
      }

      if (event.type === 'agent_online') {
        onlineAgents.add(event.data.name);
        if (agents[event.data.name]) agents[event.data.name].online = true;
        renderAgentList();
      }

      if (event.type === 'agent_offline') {
        onlineAgents.delete(event.data.name);
        if (agents[event.data.name]) agents[event.data.name].online = false;
        renderAgentList();
      }
    };

    ws.onclose = () => {
      if (currentAgent) setTimeout(connectWS, 3000);
    };
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      loadConversations();
      loadRooms();
    }, 10000);
  }

  // Copy buttons
  document.addEventListener('click', (e) => {
    if (!e.target.classList.contains('copy-btn')) return;
    const target = document.getElementById(e.target.dataset.target);
    if (!target) return;
    navigator.clipboard.writeText(target.textContent).then(() => {
      e.target.textContent = 'Copied!';
      setTimeout(() => { e.target.textContent = 'Copy'; }, 1500);
    });
  });

  // Boot
  loadLanding();
})();
