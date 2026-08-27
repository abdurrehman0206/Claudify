'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const paths = require('./paths');
const guard = require('./guard');
const locator = require('./locator');
const codeSessions = require('./codeSessions');

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
    this.usage = {};
    this.usageInFlight = false;
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
      usage: this.usage,
    };
  }

  /**
   * Refreshes memory stats on their own slower cadence. Reading them costs a
   * process spawn on both platforms, which is far too expensive to repeat at
   * the rate the rest of the status updates.
   */
  async refreshUsage() {
    if (this.usageInFlight) return;
    this.usageInFlight = true;
    try {
      this.usage = await this.usageByProfile();
    } catch {
      /* leave the previous reading in place */
    } finally {
      this.usageInFlight = false;
    }
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

    const isMain = paths.isMain(id);

    try {
      // The main profile is the Claude you already had, so it launches with no
      // --user-data-dir at all: that is what makes it the same instance and the
      // same signed-in account you were already using, rather than a new one.
      let dataDir = null;
      const args = [];
      if (!isMain) {
        dataDir = guard.validateDataDirectory(paths.dataDirectory(id));
        fs.mkdirSync(dataDir, { recursive: true });
        args.push(`${USER_DATA_FLAG}${dataDir}`);
      }
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
      // Only Claudify-managed profiles need the isolation check; the main
      // profile is the default directory and is always already populated.
      if (!isMain) this.scheduleVerification(id, dataDir);

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

  /**
   * Hands a Claude Code session to a profile using Claude's own
   * `claude://resume?session=<id>` deep link, so Claude does the import through
   * a supported path and Claudify never touches its session storage.
   *
   * The same spawn covers both cases. If the profile is not running it cold
   * starts and picks the link out of argv. If it is running, the spawn hits
   * Electron's single-instance lock for that user-data directory, the running
   * instance receives the argv through its `second-instance` handler, and the
   * process we just started exits. Either way the session lands in the profile
   * that was asked for, not whichever instance happens to own the protocol.
   */
  openSession(id, sessionId) {
    const profile = this.store.get(id);
    if (!profile) return { ok: false, error: 'That profile no longer exists.' };
    if (!this.installation) {
      return { ok: false, error: 'Claude Desktop was not found.' };
    }

    try {
      const args = [];
      if (!paths.isMain(id)) {
        const dataDirectory = guard.validateDataDirectory(paths.dataDirectory(id));
        fs.mkdirSync(dataDirectory, { recursive: true });
        args.push(`${USER_DATA_FLAG}${dataDirectory}`);
      }
      args.push(codeSessions.resumeURL(sessionId));
      guard.validateArguments(args);

      const child = spawn(this.installation.executable, args, {
        detached: true,
        stdio: 'ignore',
        env: guard.cleanEnvironment(),
      });
      child.on('error', () => {});
      child.unref();

      // Only claim the pid when this spawn actually became the instance; when
      // it merely forwarded argv to a running one it exits straight away.
      if (!this.isRunning(id) && child.pid) {
        this.running.set(id, { pid: child.pid, startedAt: Date.now() });
        this.store.markLaunched(id);
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

    const found = await this.listClaudeMainProcesses();
    for (const { pid, dataDir } of found) {
      // No --user-data-dir means the instance is using the default directory,
      // which is the Claude you already had open. Recognising it is what stops
      // Claudify asking you to sign in again for an account already running.
      const id = dataDir === null ? paths.MAIN_ID : byPath.get(path.resolve(dataDir));
      if (id && !this.running.has(id)) {
        this.running.set(id, { pid, startedAt: Date.now() });
      }
    }
  }

  /**
   * Memory and process count per profile.
   *
   * Attribution is by --user-data-dir rather than by walking the process tree,
   * because Chromium passes that switch down to every helper it spawns - even
   * when the top-level process was launched without it, in which case the
   * helpers carry the resolved default directory. So the switch identifies the
   * owner of every process in the tree, which a parent-pid walk would have to
   * reconstruct and would get wrong whenever a helper is reparented.
   */
  async usageByProfile() {
    const byDirectory = new Map();
    byDirectory.set(
      path.resolve(paths.mainClaudeDirectory()).toLowerCase(),
      paths.MAIN_ID
    );
    for (const profile of this.store.list()) {
      byDirectory.set(
        path.resolve(paths.dataDirectory(profile.id)).toLowerCase(),
        profile.id
      );
    }

    const usage = {};
    for (const { dataDir, memoryBytes } of await this.processStats()) {
      // No switch at all means the top-level process of the default install.
      const id = dataDir === null
        ? paths.MAIN_ID
        : byDirectory.get(path.resolve(dataDir).toLowerCase());
      if (!id) continue;
      if (!usage[id]) usage[id] = { processes: 0, memoryBytes: 0 };
      usage[id].processes += 1;
      usage[id].memoryBytes += memoryBytes;
    }
    return usage;
  }

  /**
   * The directory every Claude process lives under. Matching on this rather
   * than on the main executable is what makes the memory figure honest: an
   * Electron app spends almost all of its memory in helper processes, and on
   * macOS those are separate binaries under Contents/Frameworks, not the
   * executable itself. Filtering by the executable counted the main process
   * alone and reported a few hundred MB for an app actually using many GB.
   */
  installScope() {
    if (!this.installation) return null;

    let root;
    if (process.platform === 'darwin') {
      // The .app bundle, which contains both Contents/MacOS and the helpers.
      const bundle = this.installation.displayPath || '';
      root = bundle.endsWith('.app')
        ? bundle
        : path.dirname(path.dirname(this.installation.executable));
    } else {
      // On Windows the helpers share the executable's folder, and bundled
      // services such as cowork-svc sit just below it.
      root = path.dirname(this.installation.executable);
    }

    // Trailing separator so a sibling like "Claude.app2" cannot match.
    return root.endsWith(path.sep) ? root : root + path.sep;
  }

  /** Every Claude process with its resident memory and owning directory. */
  async processStats() {
    const stats = [];
    const scope = this.installScope();
    if (!scope) return stats;

    if (process.platform === 'darwin') {
      const output = await execFileAsync('/bin/ps', ['-axo', 'pid=,rss=,command=']);
      for (const line of output.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
        if (!match) continue;
        const command = match[3];
        if (!command.startsWith(scope)) continue;
        stats.push({
          pid: Number(match[1]),
          memoryBytes: Number(match[2]) * 1024, // ps reports RSS in KB
          dataDir: command.includes(USER_DATA_FLAG) ? extractDataDir(command) : null,
        });
      }
      return stats;
    }

    if (process.platform === 'win32') {
      // The scope goes through the environment so a path with spaces or
      // brackets cannot break the script or be read as a wildcard.
      const output = await execFileAsync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($env:CLAUDIFY_SCOPE) } | Select-Object ProcessId,WorkingSetSize,CommandLine | ConvertTo-Json -Compress',
        ],
        { env: { ...process.env, CLAUDIFY_SCOPE: scope } }
      );
      if (!output.trim()) return stats;
      let parsed;
      try {
        parsed = JSON.parse(output);
      } catch {
        return stats;
      }
      for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
        if (!row) continue;
        stats.push({
          pid: Number(row.ProcessId),
          memoryBytes: Number(row.WorkingSetSize) || 0,
          dataDir:
            row.CommandLine && row.CommandLine.includes(USER_DATA_FLAG)
              ? extractDataDir(row.CommandLine)
              : null,
        });
      }
    }

    return stats;
  }

  // Returns only the top-level Claude processes: helper processes (renderer,
  // gpu, utility) carry --type=, the main process does not.
  async listClaudeMainProcesses() {
    const results = [];

    if (process.platform === 'darwin') {
      const executable = this.installation ? this.installation.executable : null;
      const output = await execFileAsync('/bin/ps', ['-axww', '-o', 'pid=,command=']);
      for (const line of output.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const match = trimmed.match(/^(\d+)\s+(.*)$/);
        if (!match) continue;
        const command = match[2];
        // Without the flag to key on, identify Claude by its executable path.
        if (executable && !command.startsWith(executable)) continue;
        if (command.includes('--type=')) continue;
        results.push({
          pid: Number(match[1]),
          dataDir: command.includes(USER_DATA_FLAG) ? extractDataDir(command) : null,
        });
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
        if (!cmd) continue;
        if (cmd.includes('--type=')) continue;
        results.push({
          pid: Number(row.ProcessId),
          dataDir: cmd.includes(USER_DATA_FLAG) ? extractDataDir(cmd) : null,
        });
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
