'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Finds the installed Claude Desktop. Strictly read-only: Claudify never
// copies, modifies, or re-signs the application, so Claude's own code signature
// and auto-updates stay intact.

function isExecutableFile(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readDirSafe(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function compareVersionsDesc(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pb[i] || 0) - (pa[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ---------------------------------------------------------------- macOS

function macExecutableFor(bundlePath) {
  const macosDir = path.join(bundlePath, 'Contents', 'MacOS');
  const entries = readDirSafe(macosDir).filter((e) => e.isFile());
  if (!entries.length) return null;

  // Prefer an executable named after the bundle, else the first executable.
  const preferred = path.basename(bundlePath, '.app');
  const names = entries.map((e) => e.name);
  const ordered = names.includes(preferred)
    ? [preferred, ...names.filter((n) => n !== preferred)]
    : names;

  for (const name of ordered) {
    const candidate = path.join(macosDir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function macVersionFor(bundlePath) {
  // Best effort: XML Info.plist parses, binary plist simply yields null.
  try {
    const raw = fs.readFileSync(
      path.join(bundlePath, 'Contents', 'Info.plist'),
      'utf8'
    );
    const match = raw.match(
      /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/
    );
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

function macCandidates() {
  return [
    '/Applications/Claude.app',
    path.join(os.homedir(), 'Applications', 'Claude.app'),
  ];
}

function inspectMac(bundlePath) {
  if (!fs.existsSync(bundlePath)) return null;
  const executable = macExecutableFor(bundlePath);
  if (!executable) return null;
  return {
    platform: 'darwin',
    displayPath: bundlePath,
    executable,
    version: macVersionFor(bundlePath),
    kind: 'app-bundle',
  };
}

// -------------------------------------------------------------- Windows

function windowsCandidates() {
  const found = [];
  const local = process.env.LOCALAPPDATA;
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';

  // 1. Standard (Squirrel) install: %LOCALAPPDATA%\AnthropicClaude\app-<ver>\claude.exe
  if (local) {
    const anthropic = path.join(local, 'AnthropicClaude');
    const versioned = readDirSafe(anthropic)
      .filter((e) => e.isDirectory() && e.name.startsWith('app-'))
      .map((e) => e.name)
      .sort((a, b) =>
        compareVersionsDesc(a.replace(/^app-/, ''), b.replace(/^app-/, ''))
      );
    for (const dir of versioned) {
      found.push(path.join(anthropic, dir, 'claude.exe'));
    }
    found.push(path.join(anthropic, 'claude.exe'));
    found.push(path.join(local, 'Programs', 'Claude', 'Claude.exe'));
  }

  // 2. Store / MSIX install: Program Files\WindowsApps\Claude_<ver>_x64__<id>\app\claude.exe
  // The package is a Windows.FullTrustApplication, so launching its executable
  // directly works and honours command-line switches.
  const windowsApps = path.join(programFiles, 'WindowsApps');
  const packages = readDirSafe(windowsApps)
    .filter((e) => e.isDirectory() && /^Claude_/i.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => {
      const va = (a.split('_')[1] || '0');
      const vb = (b.split('_')[1] || '0');
      return compareVersionsDesc(va, vb);
    });
  for (const pkg of packages) {
    found.push(path.join(windowsApps, pkg, 'app', 'claude.exe'));
  }

  return found;
}

function windowsVersionFor(executable) {
  // MSIX package folders carry the version in their name.
  const match = executable.match(/Claude_(\d+(?:\.\d+)+)_/i);
  if (match) return match[1];
  const app = executable.match(/[\\/]app-(\d+(?:\.\d+)+)[\\/]/i);
  return app ? app[1] : null;
}

function inspectWindows(executable) {
  if (!isExecutableFile(executable)) return null;
  return {
    platform: 'win32',
    displayPath: executable,
    executable,
    version: windowsVersionFor(executable),
    kind: /WindowsApps/i.test(executable) ? 'msix-package' : 'installer',
  };
}

// ----------------------------------------------------------------- API

// Accepts either a .app bundle (macOS) or an executable (Windows), so the
// "Choose..." button in Settings can take whatever the user picks.
function inspect(target) {
  if (!target) return null;
  if (process.platform === 'darwin') {
    if (target.endsWith('.app')) return inspectMac(target);
    if (isExecutableFile(target)) {
      return {
        platform: 'darwin',
        displayPath: target,
        executable: target,
        version: null,
        kind: 'executable',
      };
    }
    return null;
  }
  return inspectWindows(target);
}

function locate(overridePath) {
  if (overridePath) {
    const found = inspect(overridePath);
    if (found) return found;
  }

  if (process.platform === 'darwin') {
    for (const bundle of macCandidates()) {
      const found = inspectMac(bundle);
      if (found) return found;
    }
    return null;
  }

  if (process.platform === 'win32') {
    for (const exe of windowsCandidates()) {
      const found = inspectWindows(exe);
      if (found) return found;
    }
    return null;
  }

  return null;
}

module.exports = { locate, inspect };
