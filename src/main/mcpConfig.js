'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const paths = require('./paths');

const FILE_NAME = 'claude_desktop_config.json';

// Only ever this one file. Claude keeps MCP servers in claude_desktop_config.json
// and the signed-in session in Local Storage / Network / Cookies alongside it.
// Copying anything beyond this file risks carrying an account between profiles,
// which would quietly undo the isolation Claudify exists to provide.

/** The stock Claude Desktop user-data directory - what plain Claude uses. */
function mainInstallDirectory() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Claude');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || os.homedir(), 'Claude');
  }
  return path.join(os.homedir(), '.config', 'Claude');
}

function configPathIn(directory) {
  return path.join(directory, FILE_NAME);
}

/** Parses a config file. Returns null when absent or unreadable. */
function read(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return { raw, parsed };
  } catch {
    return null;
  }
}

function serverNames(parsed) {
  const servers = parsed && parsed.mcpServers;
  if (!servers || typeof servers !== 'object') return [];
  return Object.keys(servers);
}

function summarise(file) {
  const config = read(file);
  if (!config) {
    return { available: false, servers: [], invalid: fs.existsSync(file) };
  }
  return { available: true, servers: serverNames(config.parsed), invalid: false };
}

/**
 * Every place a config could be copied from: the main Claude install, plus any
 * other profile that has one.
 */
function listSources(profiles, excludeProfileId) {
  const sources = [];

  const main = summarise(configPathIn(mainInstallDirectory()));
  sources.push({
    id: 'main',
    label: 'My main Claude install',
    detail: mainInstallDirectory(),
    ...main,
  });

  for (const profile of profiles) {
    if (profile.id === excludeProfileId) continue;
    const summary = summarise(configPathIn(paths.dataDirectory(profile.id)));
    if (!summary.available) continue;
    sources.push({
      id: profile.id,
      label: profile.name,
      detail: 'Claudify profile',
      ...summary,
    });
  }

  return sources;
}

function sourceDirectory(sourceId) {
  return sourceId === 'main'
    ? mainInstallDirectory()
    : paths.dataDirectory(sourceId);
}

/**
 * Copies the MCP config into a profile. The profile's existing file is kept
 * alongside as a timestamped .bak first, so this is always undoable by hand.
 */
function copyInto(profileId, sourceId) {
  const sourceFile = configPathIn(sourceDirectory(sourceId));
  const source = read(sourceFile);

  if (!source) {
    return {
      ok: false,
      error: fs.existsSync(sourceFile)
        ? 'That configuration file is not valid JSON, so it was not copied.'
        : 'That source has no MCP configuration yet.',
    };
  }

  const targetDirectory = paths.dataDirectory(profileId);
  const targetFile = configPathIn(targetDirectory);

  try {
    fs.mkdirSync(targetDirectory, { recursive: true });

    if (fs.existsSync(targetFile)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(targetFile, `${targetFile}.bak-${stamp}`);
    }

    // Write the source text verbatim rather than re-serialising, so comments
    // in the user's formatting and key order survive untouched.
    fs.writeFileSync(targetFile, source.raw, 'utf8');

    return { ok: true, servers: serverNames(source.parsed) };
  } catch (error) {
    return { ok: false, error: `Could not write the configuration: ${error.message}` };
  }
}

module.exports = {
  FILE_NAME,
  mainInstallDirectory,
  configPathIn,
  listSources,
  copyInto,
  summarise,
};
