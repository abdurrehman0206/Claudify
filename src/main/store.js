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

  /** Profiles Claudify created and owns. */
  list() {
    return this.profiles;
  }

  /**
   * The Claude you already had installed, presented as a profile so you do not
   * have to sign in again just to use Claudify. It is synthesised rather than
   * stored: keeping it out of profiles.json means no code path can delete it,
   * and its data directory is your real Claude session.
   */
  mainProfile() {
    const saved = this.settings.mainProfile || {};
    return {
      id: paths.MAIN_ID,
      kind: 'main',
      name: saved.name || 'Main',
      color: COLORS.includes(saved.color) ? saved.color : 'slate',
      createdAt: null,
      lastLaunchedAt: saved.lastLaunchedAt || null,
    };
  }

  /** Everything the UI should show, existing install first. */
  allProfiles() {
    return [this.mainProfile(), ...this.profiles];
  }

  get(id) {
    if (paths.isMain(id)) return this.mainProfile();
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
    // The main profile is renameable and recolourable like any other, but its
    // label lives in settings because the profile itself is synthesised.
    if (paths.isMain(id)) {
      const saved = { ...(this.settings.mainProfile || {}) };
      if (typeof name === 'string' && name.trim()) saved.name = name.trim();
      if (COLORS.includes(color)) saved.color = color;
      this.settings.mainProfile = saved;
      this.saveSettings();
      return this.mainProfile();
    }

    const profile = this.get(id);
    if (!profile) return null;
    if (typeof name === 'string' && name.trim()) profile.name = name.trim();
    if (COLORS.includes(color)) profile.color = color;
    this.saveProfiles();
    return profile;
  }

  markLaunched(id) {
    if (paths.isMain(id)) {
      this.settings.mainProfile = {
        ...(this.settings.mainProfile || {}),
        lastLaunchedAt: new Date().toISOString(),
      };
      this.saveSettings();
      return;
    }
    const profile = this.get(id);
    if (!profile) return;
    profile.lastLaunchedAt = new Date().toISOString();
    this.saveProfiles();
  }

  // The data directory goes to the Trash / Recycle Bin rather than being
  // deleted outright, so removing a profile is always recoverable.
  async remove(id) {
    // Deleting the main profile would mean trashing the Claude install you
    // already had. There is no path to that, by design.
    if (paths.isMain(id)) {
      return {
        ok: false,
        error:
          'That is your existing Claude install, not a profile Claudify created, so it cannot be removed here.',
      };
    }

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
