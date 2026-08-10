'use strict';

const { normalizeWorldPath } = require('./world-files');

const PROTECTED_WORLD_FILES = new Set([
  'layout.html',
  'index.html',
  'js/core.js',
  'css/theme.css',
  'app.js',
  'styles.css',
  'WORLD.md',
]);

const WRITABLE_WORLD_TARGETS = Object.freeze([
  'pages/*.html',
  'sections/*.html',
  'PROJECT.md',
]);

function validateWorldWritePath(input) {
  let canonicalPath;
  try {
    canonicalPath = normalizeWorldPath(input);
  } catch {
    return { allowed: false, reason: 'invalid_world_path' };
  }

  if (PROTECTED_WORLD_FILES.has(canonicalPath) || PROTECTED_WORLD_FILES.has(canonicalPath.toLowerCase())) {
    return { allowed: false, reason: 'protected_world_file' };
  }
  if (canonicalPath === 'PROJECT.md' || /^(?:pages|sections)\/[^/]+\.html$/.test(canonicalPath)) {
    return { allowed: true };
  }
  return { allowed: false, reason: 'outside_agent_write_targets' };
}

module.exports = {
  PROTECTED_WORLD_FILES,
  WRITABLE_WORLD_TARGETS,
  validateWorldWritePath,
};
