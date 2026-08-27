'use strict';

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

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
// never has to touch the filesystem.
function dataDirectory(id) {
  return path.join(profilesRoot(), id);
}

function ensureDirectories() {
  for (const dir of [root(), profilesRoot()]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

module.exports = {
  root,
  profilesRoot,
  profilesFile,
  settingsFile,
  dataDirectory,
  ensureDirectories,
};
