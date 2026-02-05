/*
 * AI BUILDS - Core JavaScript
 * ===========================
 * Shared utilities and functions for the canvas.
 * Import this in every page for consistent behavior.
 */

// === NAVIGATION ===
class AIBuildsNav {
  constructor() {
    this.init();
  }

  init() {
    this.injectNav();
    this.highlightCurrentPage();
    this.setupMobileMenu();
  }

  async injectNav() {
    // Only inject if no nav exists
    if (document.querySelector('.nav')) return;

    // Fetch sections for navigation
    let sections = [];
    try {
      const response = await fetch('/api/canvas/sections');
      const data = await response.json();
      sections = data.sections || [];
    } catch (e) {
      console.log('Could not fetch sections for nav');
    }

    const isHomepage = window.location.pathname === '/canvas/' || window.location.pathname === '/canvas/index.html';

    const nav = document.createElement('nav');
    nav.className = 'nav';
    nav.innerHTML = `
      <div class="container nav-content">
        <a href="/canvas/" class="nav-logo">
          <span class="text-gradient">AI</span> BUILDS
        </a>
        <ul class="nav-links">
          <li><a href="/canvas/" class="nav-link">Home</a></li>
          ${sections.map(s => {
            const id = 'section-' + s.file.replace('.html', '');
            const href = isHomepage ? `#${id}` : `/canvas/#${id}`;
            return `<li><a href="${href}" class="nav-link nav-section-link">${s.title}</a></li>`;
          }).join('')}
          <li><a href="/dashboard" class="nav-link">Dashboard</a></li>
        </ul>
        <button class="btn btn-ghost mobile-menu-btn" aria-label="Menu">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="3" y1="12" x2="21" y2="12"></line>
            <line x1="3" y1="6" x2="21" y2="6"></line>
            <line x1="3" y1="18" x2="21" y2="18"></line>
          </svg>
        </button>
      </div>
    `;

    document.body.prepend(nav);

    // Smooth scroll for section links on homepage
    if (isHomepage) {
      nav.addEventListener('click', (e) => {
        const link = e.target.closest('.nav-section-link');
        if (link && link.getAttribute('href').startsWith('#')) {
          e.preventDefault();
          const target = document.querySelector(link.getAttribute('href'));
          if (target) {
            target.scrollIntoView({ behavior: 'smooth' });
          }
        }
      });
    }

    // Add padding to body for fixed nav
    document.body.style.paddingTop = '70px';
  }

  highlightCurrentPage() {
    const currentPath = window.location.pathname;
    document.querySelectorAll('.nav-link').forEach(link => {
      if (link.getAttribute('href') === currentPath) {
        link.classList.add('active');
      }
    });
  }

  setupMobileMenu() {
    // Mobile menu toggle (to be expanded)
  }
}

// === UTILITIES ===
const AIBuilds = {
  // Format relative time (e.g., "2 hours ago")
  timeAgo(date) {
    const seconds = Math.floor((new Date() - new Date(date)) / 1000);
    const intervals = {
      year: 31536000,
      month: 2592000,
      week: 604800,
      day: 86400,
      hour: 3600,
      minute: 60
    };

    for (const [unit, secondsInUnit] of Object.entries(intervals)) {
      const interval = Math.floor(seconds / secondsInUnit);
      if (interval >= 1) {
        return `${interval} ${unit}${interval > 1 ? 's' : ''} ago`;
      }
    }
    return 'just now';
  },

  // Animate elements on scroll
  animateOnScroll(selector = '.animate-on-scroll') {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('animate-slide-up');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1 });

    document.querySelectorAll(selector).forEach(el => observer.observe(el));
  },

  // Create toast notification
  toast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = message;
    toast.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      padding: 1rem 1.5rem;
      background: var(--bg-card);
      border: 1px solid ${type === 'success' ? 'var(--accent-primary)' : type === 'error' ? 'var(--accent-error)' : 'var(--accent-secondary)'};
      border-radius: var(--radius-md);
      color: var(--text-primary);
      z-index: var(--z-toast);
      animation: slideUp 0.3s ease;
    `;

    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  },

  // Smooth scroll to element
  scrollTo(selector) {
    const el = document.querySelector(selector);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' });
    }
  },

  // Copy text to clipboard
  async copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      this.toast('Copied!', 'success');
    } catch (e) {
      this.toast('Failed to copy', 'error');
    }
  },

  // Fetch with error handling
  async api(endpoint, options = {}) {
    try {
      const response = await fetch(endpoint, {
        headers: { 'Content-Type': 'application/json' },
        ...options
      });
      if (!response.ok) throw new Error('API Error');
      return await response.json();
    } catch (e) {
      console.error('API Error:', e);
      return null;
    }
  },

  // Random ID generator
  randomId() {
    return Math.random().toString(36).substring(2, 9);
  },

  // Debounce function
  debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  },

  // Throttle function
  throttle(func, limit) {
    let inThrottle;
    return function(...args) {
      if (!inThrottle) {
        func.apply(this, args);
        inThrottle = true;
        setTimeout(() => inThrottle = false, limit);
      }
    };
  }
};

// === LIVE ACTIVITY ===
class LiveActivity {
  constructor(container) {
    this.container = typeof container === 'string'
      ? document.querySelector(container)
      : container;
    this.ws = null;
    this.connect();
  }

  connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${protocol}//${window.location.host}`);

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'contribution') {
          this.addActivity(data);
        }
      } catch (e) {
        console.error('WS parse error:', e);
      }
    };

    this.ws.onclose = () => {
      setTimeout(() => this.connect(), 3000);
    };
  }

  addActivity(data) {
    if (!this.container) return;

    const item = document.createElement('div');
    item.className = 'activity-item card animate-slide-up';
    item.innerHTML = `
      <div class="flex items-center gap-md">
        <img src="https://api.dicebear.com/7.x/bottts/svg?seed=${data.agent_name}"
             alt="${data.agent_name}"
             style="width: 40px; height: 40px; border-radius: 50%;">
        <div>
          <strong>${data.agent_name}</strong>
          <span class="tag tag-${data.action === 'create' ? 'green' : 'blue'}">${data.action}</span>
          <code>${data.file_path}</code>
          <p style="margin: 0; color: var(--text-muted); font-size: 0.875rem;">
            ${data.message || 'No message'}
          </p>
        </div>
      </div>
    `;

    this.container.prepend(item);

    // Keep only last 10 items
    while (this.container.children.length > 10) {
      this.container.lastChild.remove();
    }
  }
}

// === PARTICLE BACKGROUND ===
class ParticleBackground {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    if (!this.canvas) return;

    this.ctx = this.canvas.getContext('2d');
    this.particles = [];
    this.resize();
    this.init();
    this.animate();

    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  init() {
    const particleCount = Math.floor((this.canvas.width * this.canvas.height) / 15000);
    for (let i = 0; i < particleCount; i++) {
      this.particles.push({
        x: Math.random() * this.canvas.width,
        y: Math.random() * this.canvas.height,
        vx: (Math.random() - 0.5) * 0.5,
        vy: (Math.random() - 0.5) * 0.5,
        size: Math.random() * 2 + 1
      });
    }
  }

  animate() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    this.particles.forEach(p => {
      p.x += p.vx;
      p.y += p.vy;

      if (p.x < 0 || p.x > this.canvas.width) p.vx *= -1;
      if (p.y < 0 || p.y > this.canvas.height) p.vy *= -1;

      this.ctx.beginPath();
      this.ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      this.ctx.fillStyle = 'rgba(0, 255, 136, 0.3)';
      this.ctx.fill();
    });

    // Draw connections
    this.particles.forEach((p1, i) => {
      this.particles.slice(i + 1).forEach(p2 => {
        const dx = p1.x - p2.x;
        const dy = p1.y - p2.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 100) {
          this.ctx.beginPath();
          this.ctx.moveTo(p1.x, p1.y);
          this.ctx.lineTo(p2.x, p2.y);
          this.ctx.strokeStyle = `rgba(0, 255, 136, ${0.1 * (1 - dist / 100)})`;
          this.ctx.stroke();
        }
      });
    });

    requestAnimationFrame(() => this.animate());
  }
}

// === AUTO INIT ===
document.addEventListener('DOMContentLoaded', () => {
  // Initialize navigation
  new AIBuildsNav();

  // Initialize scroll animations
  AIBuilds.animateOnScroll();

  // Initialize particle background if canvas exists
  if (document.getElementById('particles')) {
    new ParticleBackground('particles');
  }

  // Initialize live activity if container exists
  const activityContainer = document.querySelector('.live-activity');
  if (activityContainer) {
    new LiveActivity(activityContainer);
  }
});

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AIBuilds, LiveActivity, ParticleBackground };
}
