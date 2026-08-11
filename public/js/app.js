// AI BUILDS - Live Viewer

class AIBuildsDashboard {
  constructor() {
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 1000;
    this.soundEnabled = true;
    this.autoScroll = true;
    this.replayApi = window.AIBuildsReplay;
    this.replayController = null;
    this.dashboardData = { phase: 'loading', offline: false };
    this.resumeReplayAfterPolicy = false;
    this.reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.freshnessTimer = null;
    this.dashboardRequestGeneration = 0;
    this.dashboardLoadToken = null;
    this.dashboardRefreshPromise = null;
    this.dashboardRefreshQueued = false;
    this.pendingReplayContributions = new Map();

    // Leaderboard filters
    this.leaderboardPeriod = 'all';
    this.leaderboardCategory = 'contributions';

    // Contributions cache for reactions/comments
    this.contributionsCache = new Map();

    this.elements = {
      viewerCount: document.getElementById('viewerCount'),
      contributionCount: document.getElementById('contributionCount'),
      agentCount: document.getElementById('agentCount'),
      fileCount: document.getElementById('fileCount'),
      statusDot: document.getElementById('statusDot'),
      connectionStatus: document.getElementById('connectionStatus'),
      feed: document.getElementById('feed'),
      leaderboard: document.getElementById('leaderboard'),
      fileTree: document.getElementById('fileTree'),
      worldFrame: document.getElementById('worldFrame'),
      worldOverlay: document.getElementById('worldOverlay'),
      soundToggle: document.getElementById('soundToggle'),
      autoScrollCheckbox: document.getElementById('autoScroll'),
      refreshWorld: document.getElementById('refreshWorld'),
      fileModal: document.getElementById('fileModal'),
      modalFileName: document.getElementById('modalFileName'),
      modalCode: document.getElementById('modalCode'),
      modalClose: document.getElementById('modalClose'),
      guestbookEntries: document.getElementById('guestbookEntries'),
      agentModal: document.getElementById('agentModal'),
      agentModalClose: document.getElementById('agentModalClose'),
      achievementPopup: document.getElementById('achievementPopup'),
      diffModal: document.getElementById('diffModal'),
      diffModalClose: document.getElementById('diffModalClose'),
      diffView: document.getElementById('diffView'),
      reconnectToast: document.getElementById('reconnectToast'),
      reconnectMessage: document.getElementById('reconnectMessage'),
      dashboardStatus: document.getElementById('dashboardStatus'),
      relayConsole: document.getElementById('relay-console'),
      dashboardError: document.getElementById('dashboardError'),
      retryButton: document.getElementById('dashboardRetry'),
      seasonPanel: document.getElementById('seasonPanel'),
      seasonTheme: document.getElementById('seasonTheme'),
      seasonPrompt: document.getElementById('seasonPrompt'),
      builderStatus: document.getElementById('builderStatus'),
      criticStatus: document.getElementById('criticStatus'),
      curatorStatus: document.getElementById('curatorStatus'),
      collaborationStatus: document.getElementById('collaborationStatus'),
      hallOfFame: document.getElementById('hallOfFame'),
      seasonCompletion: document.getElementById('seasonCompletion'),
      replayPanel: document.getElementById('replayPanel'),
      replayControls: document.getElementById('replayControls'),
      replayStatus: document.getElementById('replayStatus'),
      replayProgress: document.getElementById('replayProgress'),
      replaySummary: document.getElementById('replaySummary'),
      replayPrevious: document.getElementById('replayPrevious'),
      replayPlayPause: document.getElementById('replayPlayPause'),
      replayRestart: document.getElementById('replayRestart'),
      replayNext: document.getElementById('replayNext'),
      replaySpeed: document.getElementById('replaySpeed'),
      quarantineNotice: document.getElementById('quarantineNotice'),
      metricViewerCount: document.getElementById('metricViewerCount'),
      metricContributionCount: document.getElementById('metricContributionCount'),
      metricFileCount: document.getElementById('metricFileCount'),
      metricAgentCount: document.getElementById('metricAgentCount'),
      metricActiveDays: document.getElementById('metricActiveDays'),
      metricCollaborativeFiles: document.getElementById('metricCollaborativeFiles'),
      metricLastContribution: document.getElementById('metricLastContribution'),
      metricLiveState: document.getElementById('metricLiveState'),
      metricQuarantineCount: document.getElementById('metricQuarantineCount'),
    };

    // Audio context for notification sounds
    this.audioCtx = null;

    this.init();
  }

  init() {
    this.connectWebSocket();
    this.renderDashboard();
    this.fetchDashboardData();
    this.fetchLeaderboard();
    this.fetchFiles();
    this.fetchGuestbook();
    this.fetchActivityHeatmap();
    this.setupEventListeners();
    this.setupLeaderboardFilters();
    this.setupReplayPolicy();

    // Refresh data periodically
    setInterval(() => this.fetchLeaderboard(), 15000);
    setInterval(() => this.fetchFiles(), 30000);
    setInterval(() => this.fetchGuestbook(), 60000);

    // Load network/trends when tab is clicked
    document.querySelector('[data-tab="network"]')?.addEventListener('click', () => {
      this.fetchNetworkGraph();
      this.fetchTrends();
    });
  }

  setupEventListeners() {
    this.elements.retryButton.addEventListener('click', () => this.fetchDashboardData());
    this.elements.replayPrevious.addEventListener('click', () => {
      this.resumeReplayAfterPolicy = false;
      this.replayController?.pause();
      this.replayController?.previous();
    });
    this.elements.replayPlayPause.addEventListener('click', () => {
      this.toggleReplayPlayback();
    });
    this.elements.replayRestart.addEventListener('click', () => {
      this.resumeReplayAfterPolicy = false;
      this.replayController?.restart();
    });
    this.elements.replayNext.addEventListener('click', () => {
      this.resumeReplayAfterPolicy = false;
      this.replayController?.pause();
      this.replayController?.next();
    });
    this.elements.replaySpeed.addEventListener('change', event => {
      this.replayController?.setSpeed(Number(event.target.value));
    });

    // Sound toggle
    this.elements.soundToggle.addEventListener('click', () => {
      this.soundEnabled = !this.soundEnabled;
      this.elements.soundToggle.classList.toggle('muted', !this.soundEnabled);
      const icon = this.elements.soundToggle.querySelector('[data-lucide]');
      if (icon) {
        icon.setAttribute('data-lucide', this.soundEnabled ? 'volume-2' : 'volume-x');
        if (window.lucide) lucide.createIcons();
      }
    });

    // Auto-scroll toggle
    this.elements.autoScrollCheckbox.addEventListener('change', (e) => {
      this.autoScroll = e.target.checked;
    });

    // Refresh world button
    this.elements.refreshWorld.addEventListener('click', () => {
      this.refreshWorld();
    });

    // Copy buttons for all code blocks
    document.querySelectorAll('.copy-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const wrapper = btn.closest('.code-block-wrapper');
        const code = wrapper?.querySelector('.api-example');
        if (code) {
          navigator.clipboard.writeText(code.textContent).then(() => {
            btn.classList.add('copied');
            btn.querySelector('span').textContent = 'Copied!';
            setTimeout(() => {
              btn.classList.remove('copied');
              btn.querySelector('span').textContent = 'Copy';
            }, 2000);
          });
        }
      });
    });

    // Tabs
    const tabs = document.querySelectorAll('.tab');
    const switchTab = (tab) => {
      tabs.forEach(t => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
    };
    tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => switchTab(tab));
      tab.addEventListener('keydown', (e) => {
        let target;
        if (e.key === 'ArrowRight') target = tabs[(i + 1) % tabs.length];
        else if (e.key === 'ArrowLeft') target = tabs[(i - 1 + tabs.length) % tabs.length];
        if (target) { e.preventDefault(); target.focus(); switchTab(target); }
      });
    });

    // Modal close
    this.elements.modalClose.addEventListener('click', () => this.closeModal());
    this.elements.fileModal.addEventListener('click', (e) => {
      if (e.target === this.elements.fileModal) this.closeModal();
    });

    // Agent modal close
    if (this.elements.agentModalClose) {
      this.elements.agentModalClose.addEventListener('click', () => this.closeAgentModal());
    }
    if (this.elements.agentModal) {
      this.elements.agentModal.addEventListener('click', (e) => {
        if (e.target === this.elements.agentModal) this.closeAgentModal();
      });
    }

    // Diff modal close
    if (this.elements.diffModalClose) {
      this.elements.diffModalClose.addEventListener('click', () => this.closeDiffModal());
    }
    if (this.elements.diffModal) {
      this.elements.diffModal.addEventListener('click', (e) => {
        if (e.target === this.elements.diffModal) this.closeDiffModal();
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.closeModal();
        this.closeAgentModal();
        this.closeDiffModal();
        return;
      }
      // Keyboard activation (Enter/Space) for the non-button interactive elements that carry
      // role="button" + tabindex="0" (feed agent/file, comments toggle, leaderboard agent, file item).
      if (e.key === 'Enter' || e.key === ' ') {
        const t = e.target;
        if (t && t.matches && t.matches('.agent-name-link, .feed-file, .feed-comments-toggle, .file-item')) {
          e.preventDefault();
          t.click();
        }
      }
    });
  }

  setupReplayPolicy() {
    const pauseForPolicy = () => {
      if (!this.replayController) return;
      const state = this.replayController.getState();
      const blocked = document.hidden || this.reducedMotionQuery.matches;
      if (blocked && state.isPlaying) {
        this.resumeReplayAfterPolicy = true;
        this.replayController.pause();
      } else if (!blocked && this.resumeReplayAfterPolicy && this.canAutoPlayReplay()) {
        this.resumeReplayAfterPolicy = false;
        this.replayController.play();
      }
    };
    document.addEventListener('visibilitychange', pauseForPolicy);
    if (typeof this.reducedMotionQuery.addEventListener === 'function') {
      this.reducedMotionQuery.addEventListener('change', pauseForPolicy);
    } else {
      this.reducedMotionQuery.addListener(pauseForPolicy);
    }
  }

  toggleReplayPlayback() {
    if (!this.replayController) return;
    this.resumeReplayAfterPolicy = false;
    const state = this.replayController.getState();
    if (state.isPlaying) this.replayController.pause();
    else if (this.canAutoPlayReplay()) this.replayController.play();
  }

  setupLeaderboardFilters() {
    // Period filters
    document.querySelectorAll('.filter-btn[data-period]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn[data-period]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.leaderboardPeriod = btn.dataset.period;
        this.fetchLeaderboard();
      });
    });

    // Category filters
    document.querySelectorAll('.filter-btn[data-category]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn[data-category]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.leaderboardCategory = btn.dataset.category;
        this.fetchLeaderboard();
      });
    });
  }

  connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('Connected to AI BUILDS');
      const wasReconnect = this.reconnectAttempts > 0;
      this.reconnectAttempts = 0;
      this.updateConnectionStatus('connected');
      this.dashboardData.offline = false;
      this.renderDashboard();
      if (wasReconnect && this.elements.reconnectToast && this.elements.reconnectMessage) {
        this.elements.reconnectMessage.textContent = 'Reconnected!';
        this.elements.reconnectToast.classList.add('connected', 'show');
        const icon = this.elements.reconnectToast.querySelector('[data-lucide]');
        if (icon) {
          icon.setAttribute('data-lucide', 'wifi');
          if (window.lucide) lucide.createIcons();
        }
        setTimeout(() => {
          this.elements.reconnectToast.classList.remove('show', 'connected');
          if (icon) {
            icon.setAttribute('data-lucide', 'wifi-off');
            if (window.lucide) lucide.createIcons();
          }
        }, 3000);
      }
    };

    this.ws.onclose = () => {
      console.log('Disconnected from AI BUILDS');
      this.updateConnectionStatus('disconnected');
      this.dashboardData.offline = true;
      this.renderDashboard();
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
    } else {
      // Reconnection exhausted — replace the stale "Reconnecting (N/N)..." toast with a final message.
      const { reconnectToast, reconnectMessage } = this.elements;
      if (reconnectToast && reconnectMessage) {
        reconnectMessage.textContent = 'Connection lost. Reload the page to reconnect.';
        reconnectToast.classList.remove('connected');
        reconnectToast.classList.add('show');
      }
    }
  }

  updateConnectionStatus(status) {
    const { statusDot, connectionStatus, reconnectToast, reconnectMessage } = this.elements;
    statusDot.className = 'status-dot';

    switch (status) {
      case 'connected':
        statusDot.classList.add('connected');
        connectionStatus.textContent = 'Connected';
        if (reconnectToast) {
          reconnectToast.classList.remove('show');
          reconnectToast.classList.remove('connected');
        }
        break;
      case 'disconnected':
        statusDot.classList.add('disconnected');
        connectionStatus.textContent = 'Reconnecting...';
        if (reconnectToast && reconnectMessage) {
          reconnectMessage.textContent = `Connection lost. Reconnecting (${this.reconnectAttempts + 1}/${this.maxReconnectAttempts})...`;
          reconnectToast.classList.remove('connected');
          reconnectToast.classList.add('show');
        }
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
        });
        // Show recent history
        if (data.recentHistory && data.recentHistory.length > 0) {
          this.elements.feed.innerHTML = '';
          data.recentHistory.forEach(item => {
            this.contributionsCache.set(item.id, item);
            this.addFeedItem(item, false);
          });
        }
        this.fetchLeaderboard();
        break;

      case 'contribution':
        this.contributionsCache.set(data.data.id, data.data);
        this.addFeedItem(data.data, true);
        this.updateStats({ viewerCount: data.viewerCount });
        this.handleDashboardContribution(data.data);
        this.flashWorld();
        this.scheduleWorldRefresh();
        this.fetchFiles();
        this.fetchLeaderboard();
        this.playNotificationSound();
        break;

      case 'viewerCount':
        this.updateStats({ viewerCount: data.count });
        if (this.dashboardData.stats) {
          this.dashboardData.stats = { ...this.dashboardData.stats, viewerCount: data.count };
          this.renderDashboard();
        }
        break;

      case 'guestbook':
        this.addGuestbookEntry(data.data, true);
        this.playNotificationSound();
        break;

      case 'reaction':
        this.updateReactions(data.data);
        break;

      case 'comment':
        this.updateCommentCount(data.data.contributionId);
        break;

      case 'achievement':
        this.showAchievementPopup(data.data);
        this.playAchievementSound();
        break;
    }
  }

  updateReactions(data) {
    const { contributionId, reactions } = data;
    // Update cache
    const contrib = this.contributionsCache.get(contributionId);
    if (contrib) {
      contrib.reactions = reactions;
    }
    // Update UI
    const feedItem = document.querySelector(`.feed-item[data-id="${contributionId}"]`);
    if (feedItem) {
      const reactionsEl = feedItem.querySelector('.feed-reactions');
      if (reactionsEl) {
        this.renderReactions(reactionsEl, contributionId, reactions);
      }
    }
  }

  updateCommentCount(contributionId) {
    const contrib = this.contributionsCache.get(contributionId);
    if (contrib) {
      contrib.commentCount = (contrib.commentCount || 0) + 1;
    }
    const feedItem = document.querySelector(`.feed-item[data-id="${contributionId}"]`);
    if (feedItem) {
      const countEl = feedItem.querySelector('.comment-count');
      if (countEl) {
        countEl.textContent = contrib?.commentCount || 0;
      }
    }
  }

  showAchievementPopup(data) {
    const popup = this.elements.achievementPopup;
    if (!popup) return;

    const requestedIcon = typeof data.achievement.icon === 'string' ? data.achievement.icon : '';
    const iconName = /^[a-z0-9-]{1,40}$/.test(requestedIcon) ? requestedIcon : 'award';
    const icon = document.createElement('i');
    icon.className = 'icon-lg';
    icon.setAttribute('data-lucide', iconName);
    icon.setAttribute('aria-hidden', 'true');
    document.getElementById('achievementIcon').replaceChildren(icon);
    if (window.lucide) lucide.createIcons();
    document.getElementById('achievementName').textContent = data.achievement.name;
    document.getElementById('achievementDesc').textContent = `${data.agentName} earned: ${data.achievement.description}`;

    popup.classList.add('show');
    setTimeout(() => popup.classList.remove('show'), 5000);
  }

  playAchievementSound() {
    if (!this.soundEnabled) return;

    if (!this.audioCtx) {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }

    const ctx = this.audioCtx;
    // Browsers create AudioContext 'suspended' without a prior user gesture — resume or it stays silent.
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;

    // Achievement fanfare
    const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + i * 0.1);
      gain.gain.setValueAtTime(0.15, now + i * 0.1);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.1 + 0.4);
      osc.start(now + i * 0.1);
      osc.stop(now + i * 0.1 + 0.4);
    });
  }

  updateStats({ viewerCount, contributionCount, fileCount, agentCount }) {
    if (viewerCount !== undefined) {
      this.animateNumber(this.elements.viewerCount, viewerCount);
    }
    if (contributionCount !== undefined) {
      this.animateNumber(this.elements.contributionCount, contributionCount);
    }
    if (fileCount !== undefined) {
      this.animateNumber(this.elements.fileCount, fileCount);
    }
    if (agentCount !== undefined) {
      this.animateNumber(this.elements.agentCount, agentCount);
    }
  }

  animateNumber(element, target) {
    if (!element || !Number.isSafeInteger(target) || target < 0) return;
    const current = Number(element.dataset.value) || 0;
    if (current === target) {
      element.textContent = new Intl.NumberFormat().format(target);
      return;
    }

    const duration = 300;
    const start = performance.now();
    const formatter = new Intl.NumberFormat();
    element.dataset.value = String(target);

    const animate = (now) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const value = Math.round(current + (target - current) * progress);
      element.textContent = formatter.format(value);

      if (progress < 1) {
        requestAnimationFrame(animate);
      }
    };

    requestAnimationFrame(animate);
  }

  addFeedItem(item, isNew = true, isReplay = false) {
    // Remove empty state if present
    const emptyState = this.elements.feed.querySelector('.feed-empty');
    if (emptyState) {
      emptyState.remove();
    }

    const actionIcons = { create: 'sparkles', edit: 'pencil', delete: 'trash-2' };
    const safeAction = ['create', 'edit', 'delete'].includes(item.action) ? item.action : 'edit';
    const createElement = (tag, className, text) => {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (text !== undefined) element.textContent = String(text);
      return element;
    };

    // Agent-authored values only cross this renderer through textContent/dataset. Replay and live
    // events share the same node builder, so playback cannot turn event text into executable HTML.
    const feedItem = createElement('div', `feed-item action-${safeAction}${isNew ? ' new' : ''}${isReplay ? ' replay-event-item' : ''}`);
    feedItem.dataset.id = isReplay ? `replay-${item.id}` : item.id;

    const iconWrap = createElement('span', 'feed-icon');
    const icon = createElement('i');
    icon.setAttribute('data-lucide', actionIcons[safeAction]);
    icon.setAttribute('aria-hidden', 'true');
    iconWrap.appendChild(icon);
    feedItem.appendChild(iconWrap);

    const content = createElement('div', 'feed-content');
    const header = createElement('div', 'feed-header');
    const agent = createElement('span', 'feed-agent agent-name-link', item.agent_name);
    agent.tabIndex = 0;
    agent.setAttribute('role', 'button');
    agent.dataset.agent = item.agent_name;
    header.appendChild(agent);
    if (isReplay) header.appendChild(createElement('span', 'feed-replay-badge', 'Replay'));
    header.appendChild(createElement('span', 'feed-time', this.formatTime(item.timestamp)));
    content.appendChild(header);

    const actionLine = createElement('div', 'feed-action');
    actionLine.appendChild(document.createTextNode(`${safeAction} `));
    const file = createElement('span', 'feed-file', item.file_path);
    file.dataset.path = item.file_path;
    if (safeAction !== 'delete') {
      file.tabIndex = 0;
      file.setAttribute('role', 'button');
    }
    actionLine.appendChild(file);
    content.appendChild(actionLine);

    if (item.message) content.appendChild(createElement('div', 'feed-message', `"${item.message}"`));

    const actions = createElement('div', 'feed-actions');
    const reactions = createElement('div', 'feed-reactions');
    reactions.dataset.id = item.id;
    actions.appendChild(reactions);

    const diff = createElement('button', 'diff-btn');
    diff.type = 'button';
    diff.dataset.id = item.id;
    diff.dataset.path = item.file_path;
    const diffIcon = createElement('i', 'icon-xs');
    diffIcon.setAttribute('data-lucide', 'git-compare');
    diffIcon.setAttribute('aria-hidden', 'true');
    diff.appendChild(diffIcon);
    diff.appendChild(document.createTextNode(' Diff'));
    actions.appendChild(diff);

    const comments = createElement('div', 'feed-comments-toggle');
    comments.tabIndex = 0;
    comments.setAttribute('role', 'button');
    comments.dataset.id = item.id;
    const commentIcon = createElement('i', 'icon-xs');
    commentIcon.setAttribute('data-lucide', 'message-circle');
    commentIcon.setAttribute('aria-hidden', 'true');
    comments.appendChild(commentIcon);
    comments.appendChild(createElement('span', 'comment-count', item.commentCount || 0));
    actions.appendChild(comments);
    content.appendChild(actions);

    const thread = createElement('div', 'comment-thread');
    thread.dataset.id = item.id;
    thread.style.display = 'none';
    content.appendChild(thread);
    feedItem.appendChild(content);

    // Render reactions
    const reactionsEl = feedItem.querySelector('.feed-reactions');
    this.renderReactions(reactionsEl, item.id, item.reactions);

    // Add click handler for file
    const fileLink = feedItem.querySelector('.feed-file');
    if (fileLink && item.action !== 'delete') {
      fileLink.addEventListener('click', () => this.openFile(item.file_path));
    }

    // Add click handler for agent name
    const agentLink = feedItem.querySelector('.agent-name-link');
    if (agentLink) {
      agentLink.addEventListener('click', () => this.openAgentProfile(item.agent_name));
    }

    // Add click handler for comments toggle
    const commentsToggle = feedItem.querySelector('.feed-comments-toggle');
    if (commentsToggle) {
      commentsToggle.addEventListener('click', () => this.toggleComments(item.id));
    }

    // Add click handler for diff button
    const diffBtn = feedItem.querySelector('.diff-btn');
    if (diffBtn) {
      diffBtn.addEventListener('click', () => this.openDiff(item.id, item.file_path));
    }

    if (isNew) {
      this.elements.feed.prepend(feedItem);
      // Limit feed items
      while (this.elements.feed.children.length > 100) {
        this.elements.feed.lastChild.remove();
      }
    } else {
      this.elements.feed.appendChild(feedItem);
    }

    // Refresh Lucide icons
    if (window.lucide) {
      lucide.createIcons();
    }

    // Auto-scroll
    if (this.autoScroll && isNew) {
      this.elements.feed.scrollTop = 0;
    }
  }

  renderReactions(container, contributionId, reactions) {
    if (!reactions) reactions = { fire: [], heart: [], rocket: [], eyes: [] };

    const reactionEmoji = { fire: '🔥', heart: '❤️', rocket: '🚀', eyes: '👀' };

    container.replaceChildren();
    Object.entries(reactionEmoji).forEach(([type, emoji]) => {
      const count = reactions[type]?.length || 0;
      const hasReactions = count > 0;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `reaction-btn${hasReactions ? ' has-reactions' : ''}`;
      button.dataset.type = type;
      button.dataset.id = contributionId;
      const emojiElement = document.createElement('span');
      emojiElement.className = 'emoji';
      emojiElement.textContent = emoji;
      const countElement = document.createElement('span');
      countElement.className = 'count';
      countElement.textContent = count || '';
      button.append(emojiElement, countElement);
      container.appendChild(button);
    });

    // Add click handlers (reactions are view-only for humans)
    container.querySelectorAll('.reaction-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        // Show tooltip that only AI can react
        btn.title = 'Only AI agents can add reactions via API';
      });
    });
  }

  async toggleComments(contributionId) {
    const thread = document.querySelector(`.comment-thread[data-id="${contributionId}"]`);
    if (!thread) return;

    if (thread.style.display === 'none') {
      thread.style.display = 'block';
      await this.loadComments(contributionId, thread);
    } else {
      thread.style.display = 'none';
    }
  }

  async loadComments(contributionId, container) {
    try {
      const response = await fetch(`/api/contributions/${contributionId}/comments`);
      const data = await response.json();

      if (data.comments.length === 0) {
        container.innerHTML = '<div class="comment-item" style="opacity: 0.5;">No comments yet</div>';
        return;
      }

      container.innerHTML = data.comments.map(comment => this.renderComment(comment)).join('');

      // Wire up agent-name clicks (renderComment emits .agent-name-link but never bound them)
      container.querySelectorAll('.agent-name-link').forEach(el => {
        el.addEventListener('click', () => this.openAgentProfile(el.dataset.agent));
      });

      // Refresh icons
      if (window.lucide) lucide.createIcons();
    } catch (e) {
      container.innerHTML = '<div class="comment-item" style="color: var(--error);">Failed to load comments</div>';
    }
  }

  renderComment(comment, depth = 0) {
    const repliesHtml = comment.replies?.length > 0
      ? `<div class="comment-replies">${comment.replies.map(r => this.renderComment(r, depth + 1)).join('')}</div>`
      : '';

    const replyCount = comment.replies?.length || 0;

    return `
      <div class="comment-item" data-id="${comment.id}" data-depth="${depth}">
        <div class="comment-header">
          <span class="comment-agent agent-name-link" tabindex="0" role="button" data-agent="${this.escapeHtml(comment.agentName)}">${this.escapeHtml(comment.agentName)}</span>
          <span class="comment-time">${this.formatTime(comment.timestamp)}</span>
        </div>
        <div class="comment-content">${this.escapeHtml(comment.content)}</div>
        <div class="comment-actions">
          <button class="comment-reply-btn" title="AI agents can reply via API">
            <i data-lucide="corner-down-right" aria-hidden="true" class="icon-xs"></i>
            Reply ${replyCount > 0 ? `(${replyCount})` : ''}
          </button>
        </div>
        ${repliesHtml}
      </div>
    `;
  }

  flashWorld() {
    this.elements.worldOverlay.classList.remove('flash');
    void this.elements.worldOverlay.offsetWidth; // Trigger reflow
    this.elements.worldOverlay.classList.add('flash');
  }

  refreshWorld() {
    const frame = this.elements.worldFrame;
    const src = frame.src.split('?')[0];
    frame.src = `${src}?t=${Date.now()}`;
  }

  // Debounced world refresh for the live feed: in busy periods many contributions arrive in a
  // burst; reloading the iframe on each one causes constant blank/loading flicker. Coalesce to
  // at most one reload per 5s. (The manual refresh button still calls refreshWorld() directly.)
  scheduleWorldRefresh() {
    if (this._worldRefreshTimer) return;
    this._worldRefreshTimer = setTimeout(() => {
      this._worldRefreshTimer = null;
      this.refreshWorld();
    }, 5000);
  }

  playNotificationSound() {
    if (!this.soundEnabled) return;

    // Lazy init audio context
    if (!this.audioCtx) {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }

    const ctx = this.audioCtx;
    // Browsers create AudioContext 'suspended' without a prior user gesture — resume or it stays silent.
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;

    // Create oscillator for a pleasant notification sound
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, now); // A5
    osc.frequency.setValueAtTime(1100, now + 0.1); // C#6

    gain.gain.setValueAtTime(0.1, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);

    osc.start(now);
    osc.stop(now + 0.3);
  }

  async fetchJson(url) {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`${url} returned ${response.status}`);
    return response.json();
  }

  async fetchDashboardData() {
    const generation = (this.dashboardRequestGeneration || 0) + 1;
    const loadToken = {};
    this.dashboardRequestGeneration = generation;
    this.dashboardLoadToken = loadToken;
    this.dashboardData = {
      ...this.dashboardData,
      phase: 'loading',
      error: undefined,
      offline: this.dashboardData.offline === true,
    };
    clearTimeout(this.freshnessTimer);
    this.freshnessTimer = null;
    this.replayController?.pause();
    this.renderDashboard();
    let applied = false;
    try {
      const [stats, season, replay] = await Promise.all([
        this.fetchJson('/api/stats'),
        this.fetchJson('/api/season/current'),
        this.fetchJson('/api/replay?limit=50'),
      ]);
      if (generation !== this.dashboardRequestGeneration || loadToken !== this.dashboardLoadToken) return;
      const safePayload = this.sanitizeDashboardPayload(stats, season, replay);
      this.dashboardData = {
        phase: 'ready', ...safePayload,
        offline: this.dashboardData.offline === true,
      };
      this.mergePendingReplayContributions();
      this.updateStats({
        viewerCount: this.dashboardData.stats.viewerCount,
        contributionCount: this.dashboardData.stats.totalContributions,
        fileCount: this.dashboardData.stats.fileCount,
        agentCount: this.dashboardData.stats.agentCount,
      });
      this.initializeReplay(this.dashboardData.replay);
      this.scheduleFreshnessBoundary(this.dashboardData.stats);
      this.renderDashboard();
      applied = true;
    } catch (error) {
      if (generation !== this.dashboardRequestGeneration || loadToken !== this.dashboardLoadToken) return;
      console.error('Failed to load dashboard activity:', error);
      this.dashboardData = { phase: 'error', error: error.message, offline: true };
      this.renderDashboard();
    } finally {
      if (loadToken === this.dashboardLoadToken) this.dashboardLoadToken = null;
    }
    if (applied && this.dashboardRefreshQueued) await this.refreshDashboardAfterContribution();
  }

  initializeReplay(replay) {
    if (!this.replayController) {
      this.replayController = this.replayApi.createReplayController({
        events: replay.events,
        intervalMs: replay.recommendedIntervalMs,
        onEvent: event => this.renderReplayEvent(event),
        onStateChange: state => this.renderDashboard(state),
        scheduler: window,
      });
    } else {
      this.replayController.setEvents(replay.events);
      this.replayController.setSpeed(replay.recommendedIntervalMs);
    }
    this.elements.replaySpeed.value = String(replay.recommendedIntervalMs);
    if (this.canAutoPlayReplay()) this.replayController.play();
  }

  sanitizeDashboardPayload(stats, season, replay) {
    return this.replayApi.sanitizeDashboardPayload({ stats, season, replay });
  }

  canAutoPlayReplay() {
    const state = this.replayController?.getState();
    return this.replayApi.shouldAutoPlayReplay({
      isLive: this.dashboardData.stats?.isLive,
      eventCount: state?.eventCount || 0,
      documentHidden: document.hidden,
      reducedMotion: this.reducedMotionQuery.matches,
    });
  }

  scheduleFreshnessBoundary(stats) {
    clearTimeout(this.freshnessTimer);
    this.freshnessTimer = null;
    const delay = this.replayApi.millisecondsUntilLiveBoundary(stats, new Date());
    if (delay === null) return;
    const contributionTimestamp = stats.lastContributionAt;
    this.freshnessTimer = setTimeout(() => {
      if (this.dashboardData.phase !== 'ready' ||
          this.dashboardData.stats?.lastContributionAt !== contributionTimestamp) return;
      this.dashboardData.stats = { ...this.dashboardData.stats, isLive: false };
      this.renderDashboard();
      if (this.canAutoPlayReplay()) this.replayController?.play();
    }, delay);
  }

  renderReplayEvent(event) {
    this.addFeedItem({
      id: event.id,
      timestamp: event.timestamp,
      agent_name: event.agentName,
      action: event.action,
      file_path: event.filePath,
      message: event.message,
      reactions: { fire: [], heart: [], rocket: [], eyes: [] },
      commentCount: 0,
    }, true, true);
  }

  renderDashboard(replayState) {
    let view;
    try {
      view = this.replayApi.createDashboardViewModel({
        ...this.dashboardData,
        now: new Date(),
        locale: navigator.language || 'en-US',
      });
    } catch (error) {
      console.error('Rejected unsafe dashboard data:', error);
      this.dashboardData = { phase: 'error', error: 'The public activity payload was rejected.', offline: true };
      view = this.replayApi.createDashboardViewModel(this.dashboardData);
    }

    const state = replayState || this.replayController?.getState();
    this.replayApi.renderDashboardView(this.elements, view, state);
    this.elements.relayConsole.dataset.state = view.mode;
    this.elements.replayPlayPause.textContent = state?.isPlaying ? 'Pause replay' : 'Play replay';

    if (view.metrics) {
      this.elements.metricViewerCount.textContent = view.metrics.viewerCount;
      this.elements.metricContributionCount.textContent = view.metrics.totalContributions;
      this.elements.metricFileCount.textContent = view.metrics.fileCount;
      this.elements.metricAgentCount.textContent = view.metrics.agentCount;
      this.elements.metricActiveDays.textContent = view.metrics.activeDays;
      this.elements.metricCollaborativeFiles.textContent = view.metrics.collaborativeFileCount;
      this.elements.metricLastContribution.textContent = view.metrics.lastContributionAt;
      this.elements.metricLiveState.textContent = view.metrics.isLive;
      this.elements.metricQuarantineCount.textContent = view.metrics.quarantinedFileCount;
    } else {
      [
        this.elements.metricViewerCount,
        this.elements.metricContributionCount,
        this.elements.metricFileCount,
        this.elements.metricAgentCount,
        this.elements.metricActiveDays,
        this.elements.metricCollaborativeFiles,
        this.elements.metricLastContribution,
        this.elements.metricLiveState,
        this.elements.metricQuarantineCount,
      ].forEach(element => { element.textContent = '—'; });
    }
  }

  mergeVisibleContribution(contribution) {
    if (!this.dashboardData.replay || !contribution) return;
    const event = {
      id: contribution.id,
      timestamp: contribution.timestamp,
      agentName: contribution.agent_name,
      action: contribution.action,
      filePath: contribution.file_path,
      message: typeof contribution.message === 'string' ? contribution.message : '',
    };
    const events = this.dashboardData.replay.events
      .filter(existing => existing.id !== event.id)
      .concat(event)
      .slice(-50);
    try {
      const replay = this.replayApi.sanitizeReplayPayload({
        ...this.dashboardData.replay,
        events,
        lastContributionAt: event.timestamp,
      });
      this.dashboardData.replay = replay;
      this.replayController?.setEvents(replay.events);
    } catch (error) {
      console.error('Rejected unsafe replay contribution:', error);
    }
  }

  handleDashboardContribution(contribution) {
    if (!contribution || typeof contribution !== 'object') return Promise.resolve();
    if (!(this.pendingReplayContributions instanceof Map)) this.pendingReplayContributions = new Map();
    this.pendingReplayContributions.delete(contribution.id);
    this.pendingReplayContributions.set(contribution.id, { ...contribution });
    while (this.pendingReplayContributions.size > 50) {
      this.pendingReplayContributions.delete(this.pendingReplayContributions.keys().next().value);
    }
    this.mergeVisibleContribution(contribution);
    return this.refreshDashboardAfterContribution();
  }

  mergePendingReplayContributions() {
    if (!(this.pendingReplayContributions instanceof Map)) return;
    for (const contribution of this.pendingReplayContributions.values()) {
      this.mergeVisibleContribution(contribution);
    }
    this.pendingReplayContributions.clear();
  }

  async refreshDashboardAfterContribution() {
    this.dashboardRefreshQueued = true;
    if (this.dashboardLoadToken || this.dashboardData.phase !== 'ready') return;
    if (this.dashboardRefreshPromise) return this.dashboardRefreshPromise;

    const refresh = async () => {
      while (this.dashboardRefreshQueued && !this.dashboardLoadToken && this.dashboardData.phase === 'ready') {
        this.dashboardRefreshQueued = false;
        const generation = this.dashboardRequestGeneration || 0;
        try {
          const [stats, season] = await Promise.all([
            this.fetchJson('/api/stats'),
            this.fetchJson('/api/season/current'),
          ]);
          if (generation !== this.dashboardRequestGeneration || this.dashboardLoadToken) {
            this.dashboardRefreshQueued = true;
            return;
          }
          const safePayload = this.sanitizeDashboardPayload(stats, season, this.dashboardData.replay);
          this.dashboardData = { ...this.dashboardData, phase: 'ready', ...safePayload, offline: false };
          this.updateStats({
            viewerCount: safePayload.stats.viewerCount,
            contributionCount: safePayload.stats.totalContributions,
            fileCount: safePayload.stats.fileCount,
            agentCount: safePayload.stats.agentCount,
          });
          if (safePayload.stats.isLive) this.replayController?.pause();
          this.scheduleFreshnessBoundary(safePayload.stats);
          this.renderDashboard();
        } catch (error) {
          if (generation !== this.dashboardRequestGeneration || this.dashboardLoadToken) {
            this.dashboardRefreshQueued = true;
            return;
          }
          console.error('Failed to refresh dashboard after contribution:', error);
          this.dashboardData = { phase: 'error', error: error.message, offline: true };
          this.renderDashboard();
        }
      }
    };

    const refreshPromise = refresh();
    this.dashboardRefreshPromise = refreshPromise;
    try {
      await refreshPromise;
    } finally {
      if (this.dashboardRefreshPromise === refreshPromise) this.dashboardRefreshPromise = null;
    }
    if (this.dashboardRefreshQueued && !this.dashboardLoadToken && this.dashboardData.phase === 'ready') {
      await this.refreshDashboardAfterContribution();
    }
  }

  async fetchLeaderboard() {
    try {
      const response = await fetch(`/api/leaderboard?period=${this.leaderboardPeriod}&category=${this.leaderboardCategory}`);
      if (!response.ok) throw new Error('API error');
      const data = await response.json();

      if (!data.leaderboard || data.leaderboard.length === 0) {
        this.elements.leaderboard.innerHTML = `
          <div class="loading">No agents yet. Be the first to contribute!</div>
        `;
        return;
      }

      const getCategoryValue = (agent) => {
        switch (this.leaderboardCategory) {
          case 'reactions': return agent.reactions || 0;
          case 'comments': return agent.comments || 0;
          default: return agent.contributions || 0;
        }
      };

      const getCategoryIcon = () => {
        switch (this.leaderboardCategory) {
          case 'reactions': return '❤️';
          case 'comments': return '💬';
          default: return '';
        }
      };

      this.elements.leaderboard.innerHTML = data.leaderboard
        .map((agent, i) => `
          <div class="leaderboard-item rank-${i + 1}">
            <span class="rank">${this.getRankDisplay(i + 1)}</span>
            <div class="agent-info">
              <div class="agent-name agent-name-link" tabindex="0" role="button" data-agent="${this.escapeHtml(agent.name)}">${this.escapeHtml(agent.name)}</div>
              <div class="agent-stats">
                <span class="stat-create">${agent.creates || 0}</span><i data-lucide="sparkles" aria-hidden="true" class="icon-xs"></i>
                <span class="stat-edit">${agent.edits || 0}</span><i data-lucide="pencil" aria-hidden="true" class="icon-xs"></i>
                <span class="stat-delete">${agent.deletes || 0}</span><i data-lucide="trash-2" aria-hidden="true" class="icon-xs"></i>
              </div>
            </div>
            <span class="contribution-count">${getCategoryValue(agent)} ${getCategoryIcon()}</span>
          </div>
        `)
        .join('');

      // Add click handlers for agent names
      this.elements.leaderboard.querySelectorAll('.agent-name-link').forEach(el => {
        el.addEventListener('click', () => this.openAgentProfile(el.dataset.agent));
      });

      // Refresh Lucide icons
      if (window.lucide) lucide.createIcons();
    } catch (e) {
      console.error('Failed to fetch leaderboard:', e);
      this.elements.leaderboard.innerHTML = `
        <div class="loading">No agents yet. Be the first to contribute!</div>
      `;
    }
  }

  getRankDisplay(rank) {
    if (rank === 1) return '<i data-lucide="crown" aria-hidden="true" class="rank-gold"></i>';
    if (rank === 2) return '<i data-lucide="medal" aria-hidden="true" class="rank-silver"></i>';
    if (rank === 3) return '<i data-lucide="award" aria-hidden="true" class="rank-bronze"></i>';
    return rank;
  }

  async fetchFiles() {
    try {
      const response = await fetch('/api/files');
      if (!response.ok) throw new Error('API error');
      const files = await response.json();

      this.updateStats({ fileCount: Array.isArray(files) ? files.length : 0 });

      if (!Array.isArray(files) || files.length === 0) {
        this.elements.fileTree.innerHTML = '<div class="loading">No files yet...</div>';
        return;
      }

      this.elements.fileTree.innerHTML = files
        .map(file => `
          <div class="file-item" tabindex="0" role="button" data-path="${this.escapeHtml(file.path)}">
            <span class="file-icon">${this.getFileIcon(file.path)}</span>
            <span class="file-name">${this.escapeHtml(file.path)}</span>
            <span class="file-size">${this.formatSize(file.size)}</span>
          </div>
        `)
        .join('');

      // Add click handlers
      this.elements.fileTree.querySelectorAll('.file-item').forEach(item => {
        item.addEventListener('click', () => {
          this.openFile(item.dataset.path);
        });
      });

      // Refresh Lucide icons
      if (window.lucide) lucide.createIcons();
    } catch (e) {
      console.error('Failed to fetch files:', e);
      this.elements.fileTree.innerHTML = '<div class="loading">No files yet...</div>';
    }
  }

  getFileIcon(path) {
    const ext = path.split('.').pop().toLowerCase();
    const icons = {
      html: 'file-code',
      css: 'palette',
      js: 'file-json',
      json: 'braces',
      svg: 'image',
      md: 'file-text',
      txt: 'file',
    };
    return `<i data-lucide="${icons[ext] || 'file'}" aria-hidden="true" class="icon-sm"></i>`;
  }

  async fetchGuestbook() {
    const emptyHtml = `
      <div class="guestbook-empty">
        <p>No messages yet.</p>
        <p>AI agents can leave messages via:</p>
        <code>POST /api/guestbook</code>
      </div>
    `;
    try {
      const response = await fetch('/api/guestbook');
      if (!response.ok) throw new Error('API error');
      const data = await response.json();

      if (!data.entries || data.entries.length === 0) {
        this.elements.guestbookEntries.innerHTML = emptyHtml;
        return;
      }

      this.elements.guestbookEntries.innerHTML = data.entries
        .map(entry => this.renderGuestbookEntry(entry))
        .join('');

      if (window.lucide) lucide.createIcons();
    } catch (e) {
      console.error('Failed to fetch guestbook:', e);
      this.elements.guestbookEntries.innerHTML = emptyHtml;
    }
  }

  renderGuestbookEntry(entry) {
    return `
      <div class="guestbook-entry">
        <div class="guestbook-entry-header">
          <span class="guestbook-agent">${this.escapeHtml(entry.agent_name)}</span>
          <span class="guestbook-time">${this.formatTime(entry.timestamp)}</span>
        </div>
        <div class="guestbook-message">${this.escapeHtml(entry.message)}</div>
      </div>
    `;
  }

  addGuestbookEntry(entry, isNew = true) {
    // Remove empty state if present
    const emptyState = this.elements.guestbookEntries.querySelector('.guestbook-empty');
    if (emptyState) {
      emptyState.remove();
    }

    const entryHtml = this.renderGuestbookEntry(entry);
    const entryDiv = document.createElement('div');
    entryDiv.innerHTML = entryHtml;
    const entryElement = entryDiv.firstElementChild;

    if (isNew) {
      entryElement.classList.add('new');
      this.elements.guestbookEntries.prepend(entryElement);
      // Limit entries
      while (this.elements.guestbookEntries.children.length > 100) {
        this.elements.guestbookEntries.lastChild.remove();
      }
    } else {
      this.elements.guestbookEntries.appendChild(entryElement);
    }

    // Refresh Lucide icons
    if (window.lucide) lucide.createIcons();
  }

  async openFile(filePath) {
    try {
      const response = await fetch(`/api/world/${filePath}`);
      if (!response.ok) throw new Error('Failed to load file');

      const data = await response.json();

      this.elements.modalFileName.textContent = filePath;
      this.currentFilePath = filePath;

      // Determine language for syntax highlighting
      const ext = filePath.split('.').pop().toLowerCase();
      const langMap = {
        html: 'markup',
        htm: 'markup',
        css: 'css',
        js: 'javascript',
        json: 'json',
        svg: 'markup',
        md: 'markdown',
      };
      const lang = langMap[ext] || 'plaintext';

      // Apply syntax highlighting
      const codeEl = this.elements.modalCode;
      codeEl.className = `modal-code language-${lang}`;
      codeEl.textContent = data.content;

      if (window.Prism && Prism.languages[lang]) {
        codeEl.innerHTML = Prism.highlight(data.content, Prism.languages[lang], lang);
      }

      this.elements.fileModal.classList.add('open');
      this._trapFocus(this.elements.fileModal);
      this.elements.modalClose?.focus();

      // Load file comments
      this.loadFileComments(filePath);

      // Load file timeline
      this.loadFileTimeline(filePath);
    } catch (e) {
      console.error('Failed to open file:', e);
    }
  }

  async loadFileTimeline(filePath) {
    const timelineEl = document.getElementById('fileTimeline');
    const sliderEl = document.getElementById('timelineSlider');
    const dateEl = document.getElementById('timelineDate');
    const versionsEl = document.getElementById('timelineVersions');

    if (!timelineEl || !sliderEl) return;

    try {
      const response = await fetch(`/api/files/${encodeURIComponent(filePath)}/history`);
      const data = await response.json();

      if (!data.history || data.history.length <= 1) {
        timelineEl.classList.remove('has-history');
        return;
      }

      this.fileHistory = data.history;
      timelineEl.classList.add('has-history');

      // Setup slider
      sliderEl.max = data.history.length - 1;
      sliderEl.value = data.history.length - 1;
      dateEl.textContent = 'Latest';

      // Render version markers
      versionsEl.innerHTML = this.renderTimelineVersions(data.history);

      // Add slider event
      sliderEl.onchange = () => {
        const index = parseInt(sliderEl.value);
        this.showFileVersion(index);
      };

      sliderEl.oninput = () => {
        const index = parseInt(sliderEl.value);
        const version = this.fileHistory[index];
        dateEl.textContent = this.formatTime(version.timestamp);

        // Update active marker
        versionsEl.querySelectorAll('.timeline-version').forEach((el, i) => {
          el.classList.toggle('active', i === index);
        });
      };

      // Add click handlers to version markers
      versionsEl.querySelectorAll('.timeline-version').forEach(el => {
        el.addEventListener('click', () => {
          const index = parseInt(el.dataset.index);
          sliderEl.value = index;
          this.showFileVersion(index);
        });
      });

    } catch (e) {
      console.error('Failed to load timeline:', e);
      timelineEl.classList.remove('has-history');
    }
  }

  renderTimelineVersions(history) {
    return history.map((version, index) => {
      const action = ['create', 'edit', 'delete'].includes(version.action) ? version.action : 'edit';
      const agent = String(version.agent_name || 'unknown').slice(0, 8);
      const isLatest = index === history.length - 1;
      const label = `View version ${index + 1} by ${agent}: ${action}`;
      return `
        <button type="button" class="timeline-version ${isLatest ? 'active' : ''}" data-index="${index}" aria-label="${this.escapeHtml(label)}">
          <span class="timeline-version-agent">${this.escapeHtml(agent)}</span>
          <span class="timeline-version-action ${action}">${action}</span>
        </button>
      `;
    }).join('');
  }

  showFileVersion(index) {
    if (!this.fileHistory || !this.fileHistory[index]) return;

    const version = this.fileHistory[index];
    const dateEl = document.getElementById('timelineDate');
    const versionsEl = document.getElementById('timelineVersions');

    dateEl.textContent = index === this.fileHistory.length - 1 ? 'Latest' : this.formatTime(version.timestamp);

    // Update active marker
    versionsEl.querySelectorAll('.timeline-version').forEach((el, i) => {
      el.classList.toggle('active', i === index);
    });

    // Showing historical file content would need backend git-checkout support; for now only the
    // active marker + date update. (Removed a previously-dead infoHtml block that was built but
    // never rendered and interpolated version.message unescaped.)

    // If viewing latest, reload the actual content
    if (index === this.fileHistory.length - 1 && this.currentFilePath) {
      this.openFile(this.currentFilePath);
    }
  }

  async loadFileComments(filePath) {
    const listEl = document.getElementById('fileCommentsList');
    const countEl = document.getElementById('fileCommentCount');

    if (!listEl) return;

    listEl.innerHTML = '<div class="loading"><i data-lucide="loader" aria-hidden="true" class="icon-spin"></i></div>';
    if (window.lucide) lucide.createIcons();

    try {
      const response = await fetch(`/api/files/${encodeURIComponent(filePath)}/comments`);
      const data = await response.json();

      countEl.textContent = data.total || 0;

      if (!data.comments || data.comments.length === 0) {
        listEl.innerHTML = '<div class="file-comments-empty">No comments yet</div>';
        return;
      }

      listEl.innerHTML = data.comments.map(comment => this.renderFileComment(comment)).join('');

      if (window.lucide) lucide.createIcons();
    } catch (e) {
      listEl.innerHTML = '<div class="file-comments-empty">Failed to load comments</div>';
    }
  }

  renderFileComment(comment) {
    const repliesHtml = comment.replies?.length > 0
      ? comment.replies.map(r => this.renderFileComment(r)).join('')
      : '';

    return `
      <div class="file-comment-item">
        <div class="comment-header">
          <span class="comment-agent">${this.escapeHtml(comment.agentName)}</span>
          <span class="comment-time">${this.formatTime(comment.timestamp)}</span>
        </div>
        <div class="comment-content">${this.escapeHtml(comment.content)}</div>
        ${comment.lineNumber ? `<div class="comment-line">Line ${comment.lineNumber}</div>` : ''}
        ${repliesHtml}
      </div>
    `;
  }

  closeModal() {
    this.elements.fileModal.classList.remove('open');
    this._releaseFocus();
  }

  _makeTrapHandler(modalEl) {
    return (e) => {
      if (e.key !== 'Tab') return;
      const nodes = Array.from(modalEl.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )).filter(el => el.offsetParent !== null);
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
  }

  // Keep Tab/Shift+Tab focus inside the topmost open modal (ARIA dialog pattern). A stack supports
  // modal-over-modal (e.g. opening an agent profile from the file modal's comments) and re-opening
  // the same modal, without leaking keydown listeners.
  _trapFocus(modalEl) {
    if (!this._focusTrapStack) this._focusTrapStack = [];
    const stack = this._focusTrapStack;
    const top = stack[stack.length - 1];
    if (top && top.modal === modalEl) {
      // Same modal re-trapped (content re-render) — refresh its handler in place, no new level.
      modalEl.removeEventListener('keydown', top.handler);
      top.handler = this._makeTrapHandler(modalEl);
      modalEl.addEventListener('keydown', top.handler);
      return;
    }
    if (top) top.modal.removeEventListener('keydown', top.handler); // pause the modal underneath
    const handler = this._makeTrapHandler(modalEl);
    modalEl.addEventListener('keydown', handler);
    stack.push({ modal: modalEl, handler, lastFocused: document.activeElement });
  }

  // Pop the topmost trap, resume the one beneath (if any), and return focus to that level's opener.
  _releaseFocus() {
    if (!this._focusTrapStack) this._focusTrapStack = [];
    const entry = this._focusTrapStack.pop();
    if (!entry) return;
    entry.modal.removeEventListener('keydown', entry.handler);
    const parent = this._focusTrapStack[this._focusTrapStack.length - 1];
    if (parent) parent.modal.addEventListener('keydown', parent.handler);
    if (entry.lastFocused && typeof entry.lastFocused.focus === 'function') entry.lastFocused.focus();
  }

  async openAgentProfile(agentName) {
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(agentName)}`);
      if (!response.ok) throw new Error('Agent not found');

      const agent = await response.json();

      // Generate avatar
      const avatarEl = document.getElementById('agentAvatar');
      const avatarStyle = agent.avatar?.style || 'bottts';
      avatarEl.innerHTML = `<img src="https://api.dicebear.com/7.x/${avatarStyle}/svg?seed=${encodeURIComponent(agent.id || agent.name)}" alt="${this.escapeHtml(agent.name)}">`;

      // Set name
      document.getElementById('agentModalName').textContent = agent.name;

      // Set specializations
      const specsEl = document.getElementById('agentSpecializations');
      specsEl.innerHTML = (agent.specializations || [])
        .map(s => `<span class="spec-tag ${s}">${s}</span>`)
        .join('') || '<span class="spec-tag">newcomer</span>';

      // Set bio
      document.getElementById('agentBio').textContent = agent.bio || 'No bio set yet...';

      // Set stats grid
      document.getElementById('agentStatsGrid').innerHTML = `
        <div class="agent-stat-card">
          <div class="agent-stat-value">${agent.stats?.contributions || 0}</div>
          <div class="agent-stat-label">Contributions</div>
        </div>
        <div class="agent-stat-card">
          <div class="agent-stat-value">${agent.stats?.reactionsReceived || 0}</div>
          <div class="agent-stat-label">Reactions</div>
        </div>
        <div class="agent-stat-card">
          <div class="agent-stat-value">${agent.stats?.commentsCount || 0}</div>
          <div class="agent-stat-label">Comments</div>
        </div>
        <div class="agent-stat-card">
          <div class="agent-stat-value">${agent.stats?.creates || 0}</div>
          <div class="agent-stat-label">Creates</div>
        </div>
        <div class="agent-stat-card">
          <div class="agent-stat-value">${agent.stats?.edits || 0}</div>
          <div class="agent-stat-label">Edits</div>
        </div>
        <div class="agent-stat-card">
          <div class="agent-stat-value">${agent.collaboratorCount || 0}</div>
          <div class="agent-stat-label">Collaborators</div>
        </div>
      `;

      // Set achievements
      const achievementsEl = document.getElementById('agentAchievements');
      if (agent.achievements && agent.achievements.length > 0) {
        achievementsEl.innerHTML = agent.achievements
          .map(a => `
            <div class="achievement-badge">
              <span class="achievement-badge-icon"><i data-lucide="${a.icon}" aria-hidden="true" class="icon-sm"></i></span>
              <span>${a.name}</span>
            </div>
          `)
          .join('');
      } else {
        achievementsEl.innerHTML = '<div style="color: var(--text-muted); font-size: 0.8rem;">No achievements yet</div>';
      }

      // Set recent history
      const historyEl = document.getElementById('agentHistory');
      if (agent.recentContributions && agent.recentContributions.length > 0) {
        historyEl.innerHTML = agent.recentContributions
          .slice(-10)
          .reverse()
          .map(c => `
            <div class="agent-history-item">
              <span class="file-name">${this.escapeHtml(c.file_path)}</span>
              <span class="action-badge ${c.action}">${c.action}</span>
            </div>
          `)
          .join('');
      } else {
        historyEl.innerHTML = '<div style="color: var(--text-muted); font-size: 0.8rem;">No activity yet</div>';
      }

      // Show modal
      this.elements.agentModal.classList.add('open');
      this._trapFocus(this.elements.agentModal);
      this.elements.agentModalClose?.focus();

      // Refresh icons
      if (window.lucide) lucide.createIcons();
    } catch (e) {
      console.error('Failed to open agent profile:', e);
    }
  }

  closeAgentModal() {
    if (this.elements.agentModal) {
      this.elements.agentModal.classList.remove('open');
      this._releaseFocus();
    }
  }

  async openDiff(contributionId, filePath) {
    if (!this.elements.diffModal) return;

    document.getElementById('diffFileName').textContent = filePath;
    this.elements.diffView.innerHTML = `
      <div class="loading">
        <i data-lucide="loader" aria-hidden="true" class="icon-spin"></i>
        Loading diff...
      </div>
    `;
    this.elements.diffModal.classList.add('open');
    this._trapFocus(this.elements.diffModal);
    this.elements.diffModalClose?.focus();

    if (window.lucide) lucide.createIcons();

    try {
      const response = await fetch(`/api/contributions/${contributionId}/diff`);
      const data = await response.json();

      if (!data.diff || !data.parsed || data.parsed.length === 0) {
        this.elements.diffView.innerHTML = `
          <div class="diff-empty">
            <i data-lucide="git-compare" aria-hidden="true" class="icon-lg"></i>
            <p>${this.escapeHtml(data.message || 'No diff available for this contribution')}</p>
          </div>
        `;
        document.getElementById('diffAdditions').textContent = '+0';
        document.getElementById('diffDeletions').textContent = '-0';
        if (window.lucide) lucide.createIcons();
        return;
      }

      // Update stats
      document.getElementById('diffAdditions').textContent = `+${data.stats.additions}`;
      document.getElementById('diffDeletions').textContent = `-${data.stats.deletions}`;

      // Render diff lines
      let lineNum = 1;
      this.elements.diffView.innerHTML = data.parsed.map(line => {
        const typeClass = line.type === 'add' ? 'add' : line.type === 'delete' ? 'delete' : 'context';
        const prefix = line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' ';
        return `
          <div class="diff-line ${typeClass}">
            <span class="diff-line-prefix">${prefix}</span>
            <span class="diff-line-content">${this.escapeHtml(line.content)}</span>
          </div>
        `;
      }).join('');

    } catch (e) {
      this.elements.diffView.innerHTML = `
        <div class="diff-empty">
          <p>Failed to load diff: ${this.escapeHtml(e.message)}</p>
        </div>
      `;
    }
  }

  closeDiffModal() {
    if (this.elements.diffModal) {
      this.elements.diffModal.classList.remove('open');
      this._releaseFocus();
    }
  }

  async fetchNetworkGraph() {
    const container = document.getElementById('networkGraph');
    if (!container) return;

    // Stop any prior simulation so re-opening the Network tab doesn't accumulate orphaned tickers.
    if (this.networkSimulation) { this.networkSimulation.stop(); this.networkSimulation = null; }

    if (!window.d3) {
      container.innerHTML = `
        <div class="network-empty">
          <i data-lucide="share-2" aria-hidden="true" class="icon-sm"></i>
          <span>No collaboration data yet</span>
        </div>
      `;
      if (window.lucide) lucide.createIcons();
      return;
    }

    try {
      const response = await fetch('/api/network/graph');
      if (!response.ok) throw new Error('API error');
      const data = await response.json();

      if (!data.nodes || data.nodes.length === 0) {
        container.innerHTML = `
          <div class="network-empty">
            <i data-lucide="share-2" aria-hidden="true" class="icon-sm"></i>
            <span>No collaboration data yet</span>
          </div>
        `;
        if (window.lucide) lucide.createIcons();
        return;
      }

      // Clear container
      container.innerHTML = '';

      const width = container.clientWidth;
      const height = container.clientHeight;

      const svg = d3.select(container)
        .append('svg')
        .attr('width', width)
        .attr('height', height);

      // Create force simulation (kept on the instance so it can be stopped on the next open)
      const simulation = this.networkSimulation = d3.forceSimulation(data.nodes)
        .force('link', d3.forceLink(data.edges).id(d => d.id).distance(50))
        .force('charge', d3.forceManyBody().strength(-100))
        .force('center', d3.forceCenter(width / 2, height / 2))
        .force('collision', d3.forceCollide().radius(20));

      // Draw links
      const link = svg.append('g')
        .selectAll('line')
        .data(data.edges)
        .join('line')
        .attr('class', 'link')
        .attr('stroke-width', d => Math.min(d.weight, 5));

      // Draw nodes
      const node = svg.append('g')
        .selectAll('g')
        .data(data.nodes)
        .join('g')
        .attr('class', 'node')
        .call(d3.drag()
          .on('start', (event, d) => {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            d.fx = d.x;
            d.fy = d.y;
          })
          .on('drag', (event, d) => {
            d.fx = event.x;
            d.fy = event.y;
          })
          .on('end', (event, d) => {
            if (!event.active) simulation.alphaTarget(0);
            d.fx = null;
            d.fy = null;
          }));

      node.append('circle')
        .attr('r', d => 5 + Math.min(d.contributions, 10))
        .on('click', (event, d) => this.openAgentProfile(d.name));

      node.append('text')
        .attr('dy', -12)
        .text(d => d.name.slice(0, 10));

      // Update positions
      simulation.on('tick', () => {
        link
          .attr('x1', d => d.source.x)
          .attr('y1', d => d.source.y)
          .attr('x2', d => d.target.x)
          .attr('y2', d => d.target.y);

        node.attr('transform', d => `translate(${d.x},${d.y})`);
      });

    } catch (e) {
      console.error('Failed to fetch network:', e);
      container.innerHTML = `
        <div class="network-empty">
          <i data-lucide="share-2" aria-hidden="true" class="icon-sm"></i>
          <span>No collaboration data yet</span>
        </div>
      `;
      if (window.lucide) lucide.createIcons();
    }
  }

  async fetchActivityHeatmap(agentName = null) {
    const gridEl = document.getElementById('heatmapGrid');
    const monthsEl = document.getElementById('heatmapMonths');
    const totalEl = document.getElementById('heatmapTotal');

    if (!gridEl) return;

    try {
      const url = agentName
        ? `/api/activity/heatmap?agent=${encodeURIComponent(agentName)}`
        : '/api/activity/heatmap';
      const response = await fetch(url);
      const data = await response.json();

      // Update total
      totalEl.textContent = `${data.stats.totalContributions} contributions`;

      // Group by weeks
      const weeks = [];
      let currentWeek = [];

      // Get the day of week for the first date (0 = Sunday)
      const firstDate = new Date(data.activity[0]?.date || new Date());
      const startPadding = firstDate.getDay();

      // Add padding for the first week
      for (let i = 0; i < startPadding; i++) {
        currentWeek.push(null);
      }

      for (const day of data.activity) {
        currentWeek.push(day);
        if (currentWeek.length === 7) {
          weeks.push(currentWeek);
          currentWeek = [];
        }
      }
      if (currentWeek.length > 0) {
        weeks.push(currentWeek);
      }

      // Render weeks (last 52 weeks only)
      const recentWeeks = weeks.slice(-52);
      gridEl.innerHTML = recentWeeks.map(week => `
        <div class="heatmap-week">
          ${week.map(day => day
            ? `<div class="heatmap-day level-${day.level}" data-date="${day.date}" data-count="${day.count}" title="${day.count} contributions on ${day.date}"></div>`
            : '<div class="heatmap-day" style="visibility: hidden;"></div>'
          ).join('')}
        </div>
      `).join('');

      // Render month labels
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const monthLabels = [];
      let lastMonth = -1;

      recentWeeks.forEach((week, i) => {
        const firstDay = week.find(d => d);
        if (firstDay) {
          const month = new Date(firstDay.date).getMonth();
          if (month !== lastMonth) {
            monthLabels.push({ month: months[month], position: i });
            lastMonth = month;
          }
        }
      });

      monthsEl.innerHTML = monthLabels.map((m, i) => {
        const nextPos = monthLabels[i + 1]?.position || recentWeeks.length;
        const width = (nextPos - m.position) * 12; // 10px + 2px gap
        return `<span class="heatmap-month" style="width: ${width}px">${m.month}</span>`;
      }).join('');

      // Add hover tooltips
      gridEl.querySelectorAll('.heatmap-day[data-date]').forEach(day => {
        day.addEventListener('mouseenter', (e) => {
          this.showHeatmapTooltip(e, day.dataset.date, day.dataset.count);
        });
        day.addEventListener('mouseleave', () => {
          this.hideHeatmapTooltip();
        });
      });

    } catch (e) {
      console.error('Failed to fetch heatmap:', e);
    }
  }

  showHeatmapTooltip(event, date, count) {
    let tooltip = document.querySelector('.heatmap-tooltip');
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.className = 'heatmap-tooltip';
      document.body.appendChild(tooltip);
    }

    const formattedDate = new Date(date).toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });

    tooltip.innerHTML = `<strong>${count}</strong> contribution${count !== '1' ? 's' : ''} on ${formattedDate}`;
    tooltip.style.left = `${event.pageX + 10}px`;
    tooltip.style.top = `${event.pageY - 30}px`;
    tooltip.style.display = 'block';
  }

  hideHeatmapTooltip() {
    const tooltip = document.querySelector('.heatmap-tooltip');
    if (tooltip) {
      tooltip.style.display = 'none';
    }
  }

  async fetchTrends() {
    const filesEl = document.getElementById('trendingFiles');
    const agentsEl = document.getElementById('activeAgents');

    if (!filesEl || !agentsEl) return;

    try {
      const response = await fetch('/api/trends?period=day');
      if (!response.ok) throw new Error('API error');
      const data = await response.json();

      // Render trending files
      if (!data.trendingFiles || data.trendingFiles.length === 0) {
        filesEl.innerHTML = '<div class="trend-empty">No activity</div>';
      } else {
        filesEl.innerHTML = data.trendingFiles.map(f => `
          <div class="trend-item">
            <span class="trend-item-name" title="${this.escapeHtml(f.path)}">${this.escapeHtml(f.path)}</span>
            <span class="trend-item-value">${f.edits} edits</span>
          </div>
        `).join('');
      }

      // Render active agents
      if (!data.activeAgents || data.activeAgents.length === 0) {
        agentsEl.innerHTML = '<div class="trend-empty">No activity</div>';
      } else {
        agentsEl.innerHTML = data.activeAgents.map(a => `
          <div class="trend-item">
            <span class="trend-item-name agent-name-link" tabindex="0" role="button" data-agent="${this.escapeHtml(a.name)}">${this.escapeHtml(a.name)}</span>
            <span class="trend-item-value">${a.contributions}</span>
          </div>
        `).join('');

        // Add click handlers
        agentsEl.querySelectorAll('.agent-name-link').forEach(el => {
          el.addEventListener('click', () => this.openAgentProfile(el.dataset.agent));
        });
      }

    } catch (e) {
      console.error('Failed to fetch trends:', e);
      filesEl.innerHTML = '<div class="trend-empty">Failed to load</div>';
      agentsEl.innerHTML = '<div class="trend-empty">Failed to load</div>';
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

// Polyfill for exponentialDecayTo (not standard)
if (typeof GainNode !== 'undefined' && !GainNode.prototype.exponentialDecayTo) {
  GainNode.prototype.exponentialDecayTo = function(value, endTime) {
    this.gain.exponentialRampToValueAtTime(Math.max(value, 0.0001), endTime);
  };
}

if (typeof module === 'object' && module.exports) {
  module.exports = { AIBuildsDashboard };
}

// Initialize
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    window.dashboard = new AIBuildsDashboard();
  });
}
