'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { shell } = require('electron');

const paths = require('./paths');
const guard = require('./guard');

const COLORS = [
  'blue',
  'purple',
  'pink',
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'slate',
];

function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSON(file, value) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temp, file);
}

class Store {
  constructor() {
    paths.ensureDirectories();
    this.profiles = [];
    this.settings = { claudePath: null };
    this.load();
  }

  load() {
    const file = paths.profilesFile();
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        this.profiles = Array.isArray(parsed) ? parsed : [];
      } catch {
        // Never silently discard: keep the unreadable file next to the new one.
        const backup = `${file}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(file, backup);
        } catch {
          /* ignore */
        }
        this.profiles = [];
        this.loadError = `profiles.json could not be read. It was kept as ${backup}.`;
      }
    }
    this.settings = { claudePath: null, ...readJSON(paths.settingsFile(), {}) };
  }

  saveProfiles() {
    paths.ensureDirectories();
    writeJSON(paths.profilesFile(), this.profiles);
  }

  saveSettings() {
    paths.ensureDirectories();
    writeJSON(paths.settingsFile(), this.settings);
  }

  list() {
    return this.profiles;
  }

  get(id) {
    return this.profiles.find((p) => p.id === id) || null;
  }

  add({ name, color }) {
    const trimmed = String(name || '').trim();
    const profile = {
      id: crypto.randomUUID(),
      name: trimmed || 'Untitled',
      color: COLORS.includes(color) ? color : 'blue',
      createdAt: new Date().toISOString(),
      lastLaunchedAt: null,
    };
    this.profiles.push(profile);
    fs.mkdirSync(paths.dataDirectory(profile.id), { recursive: true });
    this.saveProfiles();
    return profile;
  }

  update(id, { name, color }) {
    const profile = this.get(id);
    if (!profile) return null;
    if (typeof name === 'string' && name.trim()) profile.name = name.trim();
    if (COLORS.includes(color)) profile.color = color;
    this.saveProfiles();
    return profile;
  }

  markLaunched(id) {
    const profile = this.get(id);
    if (!profile) return;
    profile.lastLaunchedAt = new Date().toISOString();
    this.saveProfiles();
  }

  // The data directory goes to the Trash / Recycle Bin rather than being
  // deleted outright, so removing a profile is always recoverable.
  async remove(id) {
    const profile = this.get(id);
    if (!profile) return { ok: false, error: 'That profile no longer exists.' };

    const dir = guard.validateDataDirectory(paths.dataDirectory(id));
    if (fs.existsSync(dir)) {
      // Windows in particular can still be releasing handles for a moment
      // after Claude exits, so a first failure is worth retrying.
      let lastError = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await shell.trashItem(dir);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          await new Promise((resolve) => setTimeout(resolve, 700));
        }
      }
      if (lastError) {
        return {
          ok: false,
          error: `Could not move the data for ${profile.name} to the Trash: ${lastError.message}`,
        };
      }
    }

    this.profiles = this.profiles.filter((p) => p.id !== id);
    this.saveProfiles();
    return { ok: true };
  }

  diskUsage(id) {
    const dir = paths.dataDirectory(id);
    let total = 0;
    const walk = (current) => {
      let entries;
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = `${current}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          try {
            total += fs.statSync(full).size;
          } catch {
            /* ignore */
          }
        }
      }
    };
    walk(dir);
    return total;
  }

  setClaudePath(value) {
    this.settings.claudePath = value || null;
    this.saveSettings();
  }
}

module.exports = { Store, COLORS };
