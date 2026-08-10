const fs = require('node:fs/promises');
const path = require('node:path');

class WorldPathError extends Error {
  constructor(message = 'Private world path') {
    super(message);
    this.name = 'WorldPathError';
    this.code = 'PRIVATE_WORLD_PATH';
  }
}

function normalizeWorldPath(input) {
  if (typeof input !== 'string' || input.length === 0 || input.includes('\0')) {
    throw new WorldPathError('Invalid world path');
  }

  const normalized = input.replace(/\\/g, '/');
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) {
    throw new WorldPathError('Absolute world paths are private');
  }

  const segments = normalized.split('/');
  if (segments.some(segment => segment.length === 0 || segment === '..' || segment.startsWith('.'))) {
    throw new WorldPathError('Private world path');
  }

  return segments.join('/');
}

function isPrivateWorldPath(input) {
  try {
    const normalized = normalizeWorldPath(input);
    return !normalized || normalized.split('/').some(segment => segment.startsWith('.'));
  } catch {
    return true;
  }
}

function resolveWorldPath(root, input) {
  if (typeof root !== 'string' || root.length === 0) {
    throw new WorldPathError('Invalid world root');
  }

  const normalized = normalizeWorldPath(input);
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, ...normalized.split('/'));
  if (!resolvedPath.startsWith(resolvedRoot + path.sep)) {
    throw new WorldPathError('World path escapes its root');
  }

  return resolvedPath;
}

async function resolveExistingWorldFile(root, input) {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = resolveWorldPath(resolvedRoot, input);
  const rootStats = await fs.lstat(resolvedRoot);
  if (rootStats.isSymbolicLink()) {
    throw new WorldPathError('World root cannot be a symbolic link');
  }

  const normalized = normalizeWorldPath(input);
  let currentPath = resolvedRoot;
  for (const segment of normalized.split('/')) {
    currentPath = path.join(currentPath, segment);
    const stats = await fs.lstat(currentPath);
    if (stats.isSymbolicLink()) {
      throw new WorldPathError('Symbolic links are not public world files');
    }
  }

  const [realRoot, realPath] = await Promise.all([
    fs.realpath(resolvedRoot),
    fs.realpath(resolvedPath),
  ]);
  if (!realPath.startsWith(realRoot + path.sep)) {
    throw new WorldPathError('World path escapes its root');
  }

  return resolvedPath;
}

async function listWorldFiles(root, { includeHidden = false, isHidden = () => false } = {}) {
  const files = [];
  const resolvedRoot = path.resolve(root);

  async function walk(directory, prefix = '') {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }

    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (isPrivateWorldPath(relativePath) || entry.isSymbolicLink()) continue;

      const fullPath = path.join(directory, entry.name);
      const stats = await fs.lstat(fullPath);
      if (stats.isSymbolicLink()) continue;

      if (stats.isDirectory()) {
        await walk(fullPath, relativePath);
      } else if (stats.isFile() && (includeHidden || !isHidden(relativePath))) {
        files.push({ path: relativePath, size: stats.size, modified: stats.mtime });
      }
    }
  }

  try {
    const rootStats = await fs.lstat(resolvedRoot);
    if (rootStats.isSymbolicLink()) return files;
    await walk(resolvedRoot);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  return files.sort((a, b) => a.path.localeCompare(b.path));
}

module.exports = {
  WorldPathError,
  normalizeWorldPath,
  isPrivateWorldPath,
  resolveWorldPath,
  resolveExistingWorldFile,
  listWorldFiles,
};
