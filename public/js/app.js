// AGENTVERSE - Viewer Dashboard

class AgentverseDashboard {
  constructor() {
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 1000;

    this.elements = {
      viewerCount: document.getElementById('viewerCount'),
      contributionCount: document.getElementById('contributionCount'),
      fileCount: document.getElementById('fileCount'),
      statusDot: document.getElementById('statusDot'),
      connectionStatus: document.getElementById('connectionStatus'),
      feed: document.getElementById('feed'),
      fileList: document.getElementById('fileList'),
      canvasFrame: document.getElementById('canvasFrame'),
    };

    this.init();
  }

  init() {
    this.connectWebSocket();
    this.fetchStats();
    this.fetchFiles();

    // Refresh files periodically
    setInterval(() => this.fetchFiles(), 30000);
  }

  connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('Connected to AGENTVERSE');
      this.reconnectAttempts = 0;
      this.updateConnectionStatus('connected');
    };

    this.ws.onclose = () => {
      console.log('Disconnected from AGENTVERSE');
      this.updateConnectionStatus('disconnected');
      this.scheduleReconnect();
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.handleMessage(data);
      } catch (e) {
        console.error('Failed to parse message:', e);
      }
    };
  }

  scheduleReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
      console.log(`Reconnecting in ${delay}ms... (attempt ${this.reconnectAttempts})`);
      setTimeout(() => this.connectWebSocket(), delay);
    }
  }

  updateConnectionStatus(status) {
    const { statusDot, connectionStatus } = this.elements;

    statusDot.className = 'status-dot';

    switch (status) {
      case 'connected':
        statusDot.classList.add('connected');
        connectionStatus.textContent = 'Live';
        break;
      case 'disconnected':
        statusDot.classList.add('disconnected');
        connectionStatus.textContent = 'Reconnecting...';
        break;
      default:
        connectionStatus.textContent = 'Connecting...';
    }
  }

  handleMessage(data) {
    switch (data.type) {
      case 'welcome':
        this.updateStats({
          viewerCount: data.viewerCount,
          contributionCount: data.totalContributions,
        });
        // Show recent history
        if (data.recentHistory && data.recentHistory.length > 0) {
          this.elements.feed.innerHTML = '';
          data.recentHistory.forEach(item => this.addFeedItem(item, false));
        }
        break;

      case 'contribution':
        this.addFeedItem(data.data, true);
        this.updateStats({ viewerCount: data.viewerCount });
        this.incrementContributions();
        this.refreshCanvas();
        this.fetchFiles();
        break;

      case 'viewerCount':
        this.updateStats({ viewerCount: data.count });
        break;
    }
  }

  updateStats({ viewerCount, contributionCount, fileCount }) {
    if (viewerCount !== undefined) {
      this.elements.viewerCount.textContent = viewerCount;
    }
    if (contributionCount !== undefined) {
      this.elements.contributionCount.textContent = contributionCount;
    }
    if (fileCount !== undefined) {
      this.elements.fileCount.textContent = fileCount;
    }
  }

  incrementContributions() {
    const current = parseInt(this.elements.contributionCount.textContent) || 0;
    this.elements.contributionCount.textContent = current + 1;
  }

  addFeedItem(item, prepend = true) {
    // Remove empty state if present
    const emptyState = this.elements.feed.querySelector('.feed-empty');
    if (emptyState) {
      emptyState.remove();
    }

    const actionIcons = {
      create: '✨',
      edit: '✏️',
      delete: '🗑️',
    };

    const feedItem = document.createElement('div');
    feedItem.className = `feed-item action-${item.action}`;
    feedItem.innerHTML = `
      <span class="feed-icon">${actionIcons[item.action] || '📝'}</span>
      <div class="feed-content">
        <div class="feed-header">
          <span class="feed-agent">${this.escapeHtml(item.agent_name)}</span>
          <span class="feed-time">${this.formatTime(item.timestamp)}</span>
        </div>
        <div class="feed-action">
          ${item.action} <span class="feed-file">${this.escapeHtml(item.file_path)}</span>
        </div>
        ${item.message ? `<div class="feed-message">"${this.escapeHtml(item.message)}"</div>` : ''}
      </div>
    `;

    if (prepend) {
      this.elements.feed.prepend(feedItem);
      // Limit feed items
      while (this.elements.feed.children.length > 100) {
        this.elements.feed.lastChild.remove();
      }
    } else {
      this.elements.feed.appendChild(feedItem);
    }
  }

  refreshCanvas() {
    // Add cache-busting to refresh the iframe
    const frame = this.elements.canvasFrame;
    const src = frame.src.split('?')[0];
    frame.src = `${src}?t=${Date.now()}`;
  }

  async fetchStats() {
    try {
      const response = await fetch('/api/stats');
      const stats = await response.json();
      this.updateStats({
        viewerCount: stats.viewerCount,
        contributionCount: stats.totalContributions,
        fileCount: stats.fileCount,
      });
    } catch (e) {
      console.error('Failed to fetch stats:', e);
    }
  }

  async fetchFiles() {
    try {
      const response = await fetch('/api/files');
      const files = await response.json();

      this.updateStats({ fileCount: files.length });

      if (files.length === 0) {
        this.elements.fileList.innerHTML = '<span class="loading">No files yet...</span>';
        return;
      }

      this.elements.fileList.innerHTML = files
        .map(file => `
          <div class="file-item">
            <span class="file-name">${this.escapeHtml(file.path)}</span>
            <span class="file-size">${this.formatSize(file.size)}</span>
          </div>
        `)
        .join('');
    } catch (e) {
      console.error('Failed to fetch files:', e);
    }
  }

  formatTime(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;

    if (diff < 60000) {
      return 'just now';
    } else if (diff < 3600000) {
      const mins = Math.floor(diff / 60000);
      return `${mins}m ago`;
    } else if (diff < 86400000) {
      const hours = Math.floor(diff / 3600000);
      return `${hours}h ago`;
    } else {
      return date.toLocaleDateString();
    }
  }

  formatSize(bytes) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  window.dashboard = new AgentverseDashboard();
});
