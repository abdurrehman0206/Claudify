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

// Keyed by path, invalidated on mtime or size change. The interesting fields
// all come from the head of the file and never change once written, so a
// refresh only has to re-read transcripts that actually moved -- which is what
// makes polling this list cheap enough to do while the tab is open.
const describeCache = new Map();

function describeTranscriptCached(file, stat) {
  const hit = describeCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
    return hit.detail;
  }
  const detail = describeTranscript(file);
  describeCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, detail });
  return detail;
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

    // Only used when Claude has no title of its own. Compaction preambles
    // ("This session is being continued from a previous conversation…") are
    // user turns the user never wrote, and they open more than half of all
    // transcripts, so taking the first user message naively labelled most
    // sessions identically and uselessly.
    const isSynthetic =
      record.isCompactSummary === true || record.isVisibleInTranscriptOnly === true;

    if (!result.title && record.type === 'user' && record.isSidechain !== true && !isSynthetic) {
      const text = summarise(messageText(record.message));
      // Skip command wrappers and system-injected turns; they make poor titles.
      if (text && !text.startsWith('<') && !/^Caveat: The messages below/i.test(text)) {
        result.title = text;
      }
    }

    if (result.cwd && result.title) break;
  }
  return result;
}

const CLI_SESSION_ID = /"cliSessionId"\s*:\s*"([0-9a-f-]{36})"/;
const TITLE = /"title"\s*:\s*"((?:\\.|[^"\\])*)"/;
const TITLE_SOURCE = /"titleSource"\s*:\s*"([^"]*)"/;
const ARCHIVED = /"isArchived"\s*:\s*(true|false)/;

// Session records are mostly a large embedded MCP config, so they are read
// once per mtime rather than on every refresh.
const recordCache = new Map();

/**
 * Pulls what Claude itself knows about a session out of one of its records.
 * Its own title is far better than anything derivable from the transcript:
 * it is what the sidebar shows, and it is the one the user set when they
 * renamed a session by hand.
 */
function readSessionRecord(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }

  const hit = recordCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.value;

  const head = readHead(file);
  let value = null;

  // The head is the whole file for most records, so parsing is exact when it
  // works; the regexes are the fallback for the few that are larger.
  try {
    const parsed = JSON.parse(head);
    value = {
      cliSessionId: parsed.cliSessionId || null,
      title: typeof parsed.title === 'string' ? parsed.title.trim() : '',
      titleSource: parsed.titleSource || null,
      archived: parsed.isArchived === true,
    };
  } catch {
    const id = CLI_SESSION_ID.exec(head);
    if (id) {
      const title = TITLE.exec(head);
      const source = TITLE_SOURCE.exec(head);
      const archived = ARCHIVED.exec(head);
      value = {
        cliSessionId: id[1],
        title: title ? title[1].replace(/\\(.)/g, '$1').trim() : '',
        titleSource: source ? source[1] : null,
        archived: archived ? archived[1] === 'true' : false,
      };
    }
  }

  if (value && !value.cliSessionId) value = null;
  recordCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  return value;
}

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
  const known = new Map(); // cliSessionId -> { title, titleSource, archived }

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
          const record = readSessionRecord(path.join(dir, file));
          if (!record) continue;

          const list = owners.get(record.cliSessionId) || [];
          if (!list.some((entry) => entry.id === id)) list.push({ id, label });
          owners.set(record.cliSessionId, list);

          // Prefer a title the user set themselves over an auto-generated one.
          const existing = known.get(record.cliSessionId);
          const better =
            !existing ||
            (record.titleSource === 'user' && existing.titleSource !== 'user') ||
            (!existing.title && record.title);
          if (better && record.title) known.set(record.cliSessionId, record);
        }
      }
    }
  };

  scan(mainInstallDirectory(), 'main', 'Main Claude install');
  for (const profile of profiles || []) {
    scan(paths.dataDirectory(profile.id), profile.id, profile.name);
  }
  return { owners, known };
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

  const { owners, known } = ownersBySession(profiles);
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

      const detail = describeTranscriptCached(file, stat);
      const record = known.get(id);
      const ageDays = (Date.now() - stat.mtimeMs) / 86400000;
      sessions.push({
        id,
        project: dir.name,
        cwd: detail.cwd || null,
        // Claude's own title first: it is what its sidebar shows and what the
        // user set if they renamed the session themselves.
        title: (record && record.title) || detail.title || null,
        titleSource: record ? record.titleSource : null,
        archived: Boolean(record && record.archived),
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
