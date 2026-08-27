'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const paths = require('./paths');

// Claude Code keeps its transcripts in ~/.claude/projects, which lives in the
// OS home directory rather than the Electron user-data directory. That single
// fact is what makes this work: the store is *already* shared by every Claudify
// profile, so nothing has to be copied between them.
//
// This module is strictly read-only. Handing a session to a profile is done by
// launching that profile with Claude's own `claude://resume?session=<id>` deep
// link, so Claude performs the import itself through a supported path. Claudify
// never writes into Claude's session storage.

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEAD_BYTES = 64 * 1024;

function configRoot() {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  return configDir && configDir.trim()
    ? configDir
    : path.join(os.homedir(), '.claude');
}

function projectsRoot() {
  return path.join(configRoot(), 'projects');
}

const DEFAULT_RETENTION_DAYS = 30;

/**
 * Claude Code deletes transcripts older than `cleanupPeriodDays` (30 by
 * default). That, not profile switching, is what actually loses history for
 * good: once a transcript is pruned there is nothing left to hand to any
 * profile. Surfacing the remaining window is the only useful warning we can
 * give, since the deletion happens outside Claudify entirely.
 */
function retentionDays() {
  try {
    const raw = fs.readFileSync(path.join(configRoot(), 'settings.json'), 'utf8');
    const value = Number(JSON.parse(raw).cleanupPeriodDays);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_RETENTION_DAYS;
  } catch {
    return DEFAULT_RETENTION_DAYS;
  }
}

function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID.test(value);
}

/** Reads the first chunk of a transcript without pulling a 40 MB file into memory. */
function readHead(file) {
  let handle;
  try {
    handle = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = fs.readSync(handle, buffer, 0, HEAD_BYTES, 0);
    return buffer.toString('utf8', 0, read);
  } catch {
    return '';
  } finally {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle);
      } catch {
        /* ignore */
      }
    }
  }
}

/** Pulls plain text out of a message body, which may be a string or content blocks. */
function messageText(message) {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join(' ');
  }
  return '';
}

function summarise(text, limit = 120) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit - 1)}…`;
}

/**
 * Derives what we can from the head of a transcript: the working directory it
 * ran in, the git branch, and the first thing the user actually asked, which
 * makes a far better label than a UUID.
 */
function describeTranscript(file) {
  const head = readHead(file);
  if (!head) return {};

  const result = {};
  for (const line of head.split('\n')) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // a trailing partial line from the fixed-size read
    }

    if (!result.cwd && typeof record.cwd === 'string') result.cwd = record.cwd;
    if (!result.gitBranch && record.gitBranch) result.gitBranch = record.gitBranch;
    if (!result.version && record.version) result.version = record.version;
    if (!result.startedAt && record.timestamp) result.startedAt = record.timestamp;

    if (!result.title && record.type === 'user' && record.isSidechain !== true) {
      const text = summarise(messageText(record.message));
      // Skip command wrappers and system-injected turns; they make poor titles.
      if (text && !text.startsWith('<')) result.title = text;
    }

    if (result.cwd && result.title) break;
  }
  return result;
}

const CLI_SESSION_ID = /"cliSessionId"\s*:\s*"([0-9a-f-]{36})"/;

/**
 * Which profiles already hold each transcript, found by reading the
 * `cliSessionId` out of every profile's own session records. A session that no
 * profile holds is the interesting case: it exists on disk but is not in
 * anyone's list, which is exactly what an account switch strands.
 *
 * Only the head of each record is read; the full file is mostly a large
 * embedded MCP config that we have no use for here.
 */
function ownersBySession(profiles) {
  const owners = new Map();

  const scan = (baseDir, id, label) => {
    const root = path.join(baseDir, 'claude-code-sessions');
    let accounts;
    try {
      accounts = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const account of accounts) {
      if (!account.isDirectory()) continue;
      let workspaces;
      try {
        workspaces = fs.readdirSync(path.join(root, account.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const workspace of workspaces) {
        if (!workspace.isDirectory()) continue;
        const dir = path.join(root, account.name, workspace.name);
        let files;
        try {
          files = fs.readdirSync(dir);
        } catch {
          continue;
        }
        for (const file of files) {
          if (!file.endsWith('.json')) continue;
          const match = CLI_SESSION_ID.exec(readHead(path.join(dir, file)));
          if (!match) continue;
          const list = owners.get(match[1]) || [];
          if (!list.some((entry) => entry.id === id)) list.push({ id, label });
          owners.set(match[1], list);
        }
      }
    }
  };

  scan(mainInstallDirectory(), 'main', 'Main Claude install');
  for (const profile of profiles || []) {
    scan(paths.dataDirectory(profile.id), profile.id, profile.name);
  }
  return owners;
}

/** The stock Claude Desktop user-data directory. */
function mainInstallDirectory() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Claude');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || os.homedir(), 'Claude');
  }
  return path.join(os.homedir(), '.config', 'Claude');
}

/** Every resumable session on this computer, newest first. */
function listSessions(profiles) {
  const root = projectsRoot();
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { available: false, root, sessions: [] };
  }

  const owners = ownersBySession(profiles);
  const keepDays = retentionDays();
  const sessions = [];
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const projectPath = path.join(root, dir.name);

    let entries;
    try {
      entries = fs.readdirSync(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const id = entry.name.slice(0, -'.jsonl'.length);
      if (!isSessionId(id)) continue; // skip sidechain/aux files

      const file = path.join(projectPath, entry.name);
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (stat.size === 0) continue;

      const detail = describeTranscript(file);
      const ageDays = (Date.now() - stat.mtimeMs) / 86400000;
      sessions.push({
        id,
        project: dir.name,
        cwd: detail.cwd || null,
        title: detail.title || null,
        gitBranch: detail.gitBranch || null,
        startedAt: detail.startedAt || null,
        lastActivityAt: stat.mtime.toISOString(),
        bytes: stat.size,
        owners: owners.get(id) || [],
        expiresInDays: Math.max(0, Math.ceil(keepDays - ageDays)),
      });
    }
  }

  sessions.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  return { available: true, root, retentionDays: keepDays, sessions };
}

/** The deep link Claude itself handles: it imports the session and opens it. */
function resumeURL(sessionId) {
  if (!isSessionId(sessionId)) {
    throw new Error(`Refusing to build a resume link for "${sessionId}".`);
  }
  return `claude://resume?session=${sessionId}`;
}

module.exports = {
  projectsRoot,
  retentionDays,
  mainInstallDirectory,
  isSessionId,
  listSessions,
  resumeURL,
};
