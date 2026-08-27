'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const paths = require('./paths');
const guard = require('./guard');
const locator = require('./locator');

const USER_DATA_FLAG = '--user-data-dir=';
const VERIFY_DELAY_MS = 20000;

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 8000, ...options }, (error, stdout) => {
      resolve(error ? '' : String(stdout || ''));
    });
  });
}

class Launcher {
  constructor(store) {
    this.store = store;
    this.running = new Map(); // profileId -> { pid, startedAt }
    this.unverified = new Set(); // profileId
    this.installation = null;
    this.refreshInstallation();
  }

  refreshInstallation() {
    this.installation = locator.locate(this.store.settings.claudePath);
    return this.installation;
  }

  // Drops entries whose process has exited. Covers instances Claudify launched
  // and ones it adopted, uniformly.
  reconcile() {
    for (const [id, entry] of this.running) {
      if (!isAlive(entry.pid)) {
        this.running.delete(id);
        this.unverified.delete(id);
      }
    }
  }

  status() {
    this.reconcile();
    const running = {};
    for (const [id, entry] of this.running) running[id] = entry;
    return {
      installation: this.installation,
      running,
      unverified: [...this.unverified],
    };
  }

  isRunning(id) {
    const entry = this.running.get(id);
    return Boolean(entry && isAlive(entry.pid));
  }

  launch(id) {
    const profile = this.store.get(id);
    if (!profile) return { ok: false, error: 'That profile no longer exists.' };

    if (!this.installation) {
      return {
        ok: false,
        error: 'Claude Desktop was not found. Choose its location in Settings.',
      };
    }

    if (this.isRunning(id)) {
      this.focus(id);
      return { ok: true, alreadyRunning: true };
    }

    try {
      const dataDir = guard.validateDataDirectory(paths.dataDirectory(id));
      fs.mkdirSync(dataDir, { recursive: true });

      const args = [`${USER_DATA_FLAG}${dataDir}`];
      guard.validateArguments(args);

      // Spawning the executable directly is what makes this work on both
      // platforms: the launched process gets the switch verbatim, and because
      // Electron's single-instance lock lives inside the user-data directory,
      // a different directory means a genuinely independent instance rather
      // than a second window of the running one.
      const child = spawn(this.installation.executable, args, {
        detached: true,
        stdio: 'ignore',
        env: guard.cleanEnvironment(),
        windowsHide: false,
      });

      child.on('error', () => {
        this.running.delete(id);
      });
      child.unref();

      if (!child.pid) {
        return { ok: false, error: 'Claude Desktop did not start.' };
      }

      this.running.set(id, { pid: child.pid, startedAt: Date.now() });
      this.unverified.delete(id);
      this.store.markLaunched(id);
      this.scheduleVerification(id, dataDir);

      return { ok: true, pid: child.pid };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  // A working --user-data-dir means Claude starts writing into the profile
  // folder within seconds. If it stays empty while the process is alive, the
  // switch was ignored - which is how a future Claude build that closes this
  // door would first show up. Surfacing it beats silently running two windows
  // signed in to the same account.
  scheduleVerification(id, dataDir) {
    setTimeout(() => {
      if (!this.isRunning(id)) return;
      let entries = [];
      try {
        entries = fs.readdirSync(dataDir);
      } catch {
        entries = [];
      }
      if (entries.length === 0) {
        this.unverified.add(id);
      } else {
        this.unverified.delete(id);
      }
    }, VERIFY_DELAY_MS).unref?.();
  }

  quit(id) {
    const entry = this.running.get(id);
    if (!entry) return { ok: false, error: 'That profile is not running.' };
    try {
      if (process.platform === 'win32') {
        // Claude spawns a tree of helper processes; /T ends the whole tree.
        execFile('taskkill', ['/PID', String(entry.pid), '/T', '/F'], () => {});
      } else {
        process.kill(entry.pid, 'SIGTERM');
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  // Terminating is asynchronous on both platforms, and Claude holds file
  // handles inside its profile folder until it is really gone. Anything that
  // touches that folder afterwards has to wait for the process to exit.
  async quitAndWait(id, timeoutMs = 6000) {
    const entry = this.running.get(id);
    if (!entry) return;
    this.quit(id);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && isAlive(entry.pid)) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    this.running.delete(id);
    this.unverified.delete(id);
  }

  focus(id) {
    const entry = this.running.get(id);
    if (!entry) return { ok: false, error: 'That profile is not running.' };

    if (process.platform === 'darwin') {
      // Needs one-time Automation permission for System Events; if the user
      // declines, focusing simply does nothing rather than failing loudly.
      execFile(
        'osascript',
        [
          '-e',
          `tell application "System Events" to set frontmost of (first process whose unix id is ${entry.pid}) to true`,
        ],
        () => {}
      );
    } else if (process.platform === 'win32') {
      execFile(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$w = New-Object -ComObject WScript.Shell; $w.AppActivate(${entry.pid}) | Out-Null`,
        ],
        () => {}
      );
    }
    return { ok: true };
  }

  // Re-attaches to Claude instances that are already running under a known
  // profile directory, so restarting Claudify does not lose track of them.
  async adopt() {
    if (!this.installation) return;

    const byPath = new Map();
    for (const profile of this.store.list()) {
      byPath.set(path.resolve(paths.dataDirectory(profile.id)), profile.id);
    }
    if (byPath.size === 0) return;

    const found = await this.listClaudeMainProcesses();
    for (const { pid, dataDir } of found) {
      const id = byPath.get(path.resolve(dataDir));
      if (id && !this.running.has(id)) {
        this.running.set(id, { pid, startedAt: Date.now() });
      }
    }
  }

  // Returns only the top-level Claude processes: helper processes (renderer,
  // gpu, utility) carry --type=, the main process does not.
  async listClaudeMainProcesses() {
    const results = [];

    if (process.platform === 'darwin') {
      const output = await execFileAsync('/bin/ps', ['-axww', '-o', 'pid=,command=']);
      for (const line of output.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.includes(USER_DATA_FLAG)) continue;
        if (trimmed.includes('--type=')) continue;
        const match = trimmed.match(/^(\d+)\s+(.*)$/);
        if (!match) continue;
        const dataDir = extractDataDir(match[2]);
        if (dataDir) results.push({ pid: Number(match[1]), dataDir });
      }
      return results;
    }

    if (process.platform === 'win32') {
      const output = await execFileAsync('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
      ]);
      if (!output.trim()) return results;
      let parsed;
      try {
        parsed = JSON.parse(output);
      } catch {
        return results;
      }
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      for (const row of rows) {
        const cmd = row && row.CommandLine;
        if (!cmd || !cmd.includes(USER_DATA_FLAG)) continue;
        if (cmd.includes('--type=')) continue;
        const dataDir = extractDataDir(cmd);
        if (dataDir) results.push({ pid: Number(row.ProcessId), dataDir });
      }
    }

    return results;
  }
}

// Pulls the value out of --user-data-dir=... . Three shapes have to work,
// because a profile path contains spaces whenever the account name does:
//   "--user-data-dir=C:\Users\A B\..."   whole argument quoted (Windows)
//   --user-data-dir="/Users/a b/..."     value quoted
//   --user-data-dir=/Users/a b/...       bare, runs to the next switch
function extractDataDir(commandLine) {
  const index = commandLine.indexOf(USER_DATA_FLAG);
  if (index === -1) return null;

  const argumentIsQuoted = index > 0 && commandLine[index - 1] === '"';
  let rest = commandLine.slice(index + USER_DATA_FLAG.length);

  if (argumentIsQuoted) {
    const end = rest.indexOf('"');
    return (end === -1 ? rest : rest.slice(0, end)).trim() || null;
  }

  if (rest.startsWith('"')) {
    const end = rest.indexOf('"', 1);
    return end === -1 ? null : rest.slice(1, end);
  }

  const nextSwitch = rest.search(/\s+--/);
  if (nextSwitch !== -1) rest = rest.slice(0, nextSwitch);
  return rest.trim() || null;
}

module.exports = { Launcher, isAlive, extractDataDir };
