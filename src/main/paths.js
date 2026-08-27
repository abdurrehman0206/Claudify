'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app } = require('electron');

// The id of the profile that represents the Claude you already had installed,
// rather than one Claudify created. It is not stored in profiles.json: keeping
// it out of that list is what makes it impossible to delete by accident, since
// its data directory is your real Claude session.
const MAIN_ID = 'main';

/** The stock Claude Desktop user-data directory - your existing install. */
function mainClaudeDirectory() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Claude');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || os.homedir(), 'Claude');
  }
  return path.join(os.homedir(), '.config', 'Claude');
}

// Everything Claudify owns lives under Electron's per-app data directory:
//   macOS   ~/Library/Application Support/Claudify
//   Windows %APPDATA%\Claudify
// Nothing outside this tree is ever created, written to, or deleted.

function root() {
  return app.getPath('userData');
}

function profilesRoot() {
  return path.join(root(), 'Profiles');
}

function profilesFile() {
  return path.join(root(), 'profiles.json');
}

function settingsFile() {
  return path.join(root(), 'settings.json');
}

// Profile directories are keyed by id, never by name, so renaming a profile
// never has to touch the filesystem. The main profile is the exception: it
// points at the existing Claude install, which Claudify did not create and
// must never treat as its own.
function dataDirectory(id) {
  if (id === MAIN_ID) return mainClaudeDirectory();
  return path.join(profilesRoot(), id);
}

function isMain(id) {
  return id === MAIN_ID;
}

function ensureDirectories() {
  for (const dir of [root(), profilesRoot()]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

module.exports = {
  MAIN_ID,
  mainClaudeDirectory,
  isMain,
  root,
  profilesRoot,
  profilesFile,
  settingsFile,
  dataDirectory,
  ensureDirectories,
};
