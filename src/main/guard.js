'use strict';

const path = require('path');
const paths = require('./paths');

// Claude Desktop hard-exits at startup if any of these switches appears on its
// command line ("refusing to start - a debugging or network-override switch is
// present"). Claudify only ever passes --user-data-dir, but this guard runs on
// every launch so a bug here can never produce a command line that Claude
// rejects, or worse, one that weakens it.
const REFUSED_SWITCHES = new Set([
  'remote-debugging-port',
  'remote-debugging-pipe',
  'ignore-certificate-errors',
  'host-resolver-rules',
  'host-rules',
  'disable-web-security',
  'log-net-log',
  'net-log-capture-mode',
  'ssl-key-log-file',
  'renderer-cmd-prefix',
  'utility-cmd-prefix',
  'gpu-launcher',
  'zygote-cmd-prefix',
  'ppapi-plugin-launcher',
  'nacl-loader-cmd-prefix',
  'browser-subprocess-path',
]);

// Variables removed from the child's environment. The first group would change
// how Claude itself starts up; the second would leak our own Electron runtime
// into the Claude process we are launching, which breaks it.
const STRIPPED_ENV = [
  'CLAUDE_USER_DATA_DIR',
  'CLAUDE_CDP_AUTH',
  'CLAUDE_AI_URL',
  'CLAUDE_E2E_PKCE_LOG',
  'SSLKEYLOGFILE',
  'sslkeylogfile',
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'ELECTRON_NO_ASAR',
  'NODE_OPTIONS',
];

// Strips leading dashes/slashes and any =value tail, then lowercases.
// Deliberately strips repeated leading punctuation, which is stricter than
// Claude's own normaliser - erring toward classifying something as a refused
// switch is the safe direction.
function normalizeSwitch(argument) {
  let body = String(argument);
  while (body.length && (body[0] === '-' || body[0] === '/')) {
    body = body.slice(1);
  }
  const eq = body.indexOf('=');
  if (eq !== -1) body = body.slice(0, eq);
  return body.toLowerCase();
}

function validateArguments(args) {
  for (const arg of args) {
    if (REFUSED_SWITCHES.has(normalizeSwitch(arg))) {
      throw new Error(
        `Refusing to launch: "${arg}" is a switch Claude Desktop rejects at startup.`
      );
    }
  }
}

// A profile's data directory must sit inside Claudify's own Profiles folder.
// This keeps a malformed profile from ever pointing Claude at - or letting us
// later move to the Trash - somewhere it should not.
function validateDataDirectory(dir) {
  const resolved = path.resolve(dir);
  const base = path.resolve(paths.profilesRoot());
  const inside =
    resolved.startsWith(base + path.sep) && resolved.length > base.length + 1;
  if (!inside) {
    throw new Error(
      `Refusing to use "${resolved}": it is outside Claudify's profiles folder.`
    );
  }
  return resolved;
}

function cleanEnvironment() {
  const env = { ...process.env };
  for (const key of STRIPPED_ENV) delete env[key];
  return env;
}

module.exports = {
  REFUSED_SWITCHES,
  STRIPPED_ENV,
  normalizeSwitch,
  validateArguments,
  validateDataDirectory,
  cleanEnvironment,
};
