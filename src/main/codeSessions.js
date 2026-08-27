'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

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

function projectsRoot() {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  const base = configDir && configDir.trim()
    ? configDir
    : path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
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

/** Every resumable session on this computer, newest first. */
function listSessions() {
  const root = projectsRoot();
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { available: false, root, sessions: [] };
  }

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
      sessions.push({
        id,
        project: dir.name,
        cwd: detail.cwd || null,
        title: detail.title || null,
        gitBranch: detail.gitBranch || null,
        startedAt: detail.startedAt || null,
        lastActivityAt: stat.mtime.toISOString(),
        bytes: stat.size,
      });
    }
  }

  sessions.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  return { available: true, root, sessions };
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
  isSessionId,
  listSessions,
  resumeURL,
};
