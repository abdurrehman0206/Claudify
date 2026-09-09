'use strict';

const path = require('path');
const fs = require('fs');
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  shell,
  dialog,
  nativeTheme,
} = require('electron');

const paths = require('./paths');
const locator = require('./locator');
const mcpConfig = require('./mcpConfig');
const codeSessions = require('./codeSessions');
const icon = require('./icon');
const { Store, COLORS } = require('./store');
const { Launcher } = require('./launcher');

let store = null;
let launcher = null;
let mainWindow = null;
let tray = null;
let statusTimer = null;
let usageTimer = null;

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
}

// ------------------------------------------------------------------ window

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    width: 760,
    height: 640,
    minWidth: 560,
    minHeight: 460,
    show: false,
    title: 'Claudify',
    icon: process.platform === 'win32' ? icon.appImage() : undefined,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1a1917' : '#faf9f7',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Never let the app navigate itself somewhere else, and send any external
  // link to the real browser instead of opening a window inside Claudify.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  return mainWindow;
}

// -------------------------------------------------------------------- tray

function buildTrayMenu() {
  const profiles = store.allProfiles();
  const items = [];

  if (profiles.length === 0) {
    items.push({ label: 'No profiles yet', enabled: false });
  } else {
    for (const profile of profiles) {
      const running = launcher.isRunning(profile.id);
      items.push({
        label: running ? `${profile.name}  ●` : profile.name,
        click: async () => {
          if (launcher.isRunning(profile.id)) launcher.focus(profile.id);
          else await launcher.launch(profile.id);
          pushState();
        },
      });
    }
  }

  items.push({ type: 'separator' });
  items.push({ label: 'Open Claudify', click: () => createWindow() });
  items.push({ type: 'separator' });
  items.push({ label: 'Quit Claudify', click: () => app.quit() });

  return Menu.buildFromTemplate(items);
}

function createTray() {
  try {
    tray = new Tray(icon.trayImage());
    tray.setToolTip('Claudify');
    tray.setContextMenu(buildTrayMenu());
    tray.on('click', () => {
      if (process.platform === 'win32') createWindow();
    });
  } catch {
    tray = null; // A missing tray is not worth failing the app over.
  }
}

// ------------------------------------------------------------------- state

function currentState() {
  const status = launcher.status();
  return {
    platform: process.platform,
    colors: COLORS,
    profiles: store.allProfiles(),
    running: status.running,
    unverified: status.unverified,
    usage: status.usage || {},
    installation: status.installation,
    claudePathOverride: store.settings.claudePath || null,
    dataPath: paths.profilesRoot(),
    loadError: store.loadError || null,
  };
}

function pushState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state', currentState());
  }
  if (tray) {
    try {
      tray.setContextMenu(buildTrayMenu());
    } catch {
      /* ignore */
    }
  }
}

// -------------------------------------------------------------------- IPC

function registerIPC() {
  // A handler that throws should reach the UI as a message it can show, not as
  // a rejected promise every call site would have to guard against.
  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        return await fn(event, ...args);
      } catch (error) {
        return { ok: false, error: error.message || String(error) };
      }
    });
  };

  handle('state:get', () => currentState());

  handle('profile:add', (_event, payload) => {
    const options = payload || {};
    const profile = store.add(options);

    // A brand-new profile starts with no MCP servers, because Claude reads them
    // from inside the user-data directory. Copying them across on creation is
    // what makes a new profile feel like signing in as another account rather
    // than starting from nothing.
    let mcp = null;
    if (options.copyMcpFrom) {
      mcp = mcpConfig.copyInto(profile.id, options.copyMcpFrom);
    }

    pushState();
    return { ok: true, profile, mcp };
  });

  // Claude Code transcripts live in ~/.claude/projects, outside the user-data
  // directory, so every profile already sees the same store. Listing is
  // read-only; handing one to a profile goes through Claude's own deep link.
  handle('sessions:list', () => codeSessions.listSessions(store.list()));

  handle('sessions:archived', () => codeSessions.listArchived(store.list()));

  // The one write into Claude's own storage: clearing an archive flag it
  // offers no way to clear itself. Refused while that profile runs.
  handle('sessions:unarchive', (_event, { file, profileId }) => {
    const result = codeSessions.unarchive(file, {
      profileRunning: launcher.isRunning(profileId),
    });
    pushState();
    return result;
  });

  handle('sessions:open', async (_event, { profileId, sessionId }) => {
    const result = await launcher.openSession(profileId, sessionId);
    pushState();
    return result;
  });

  handle('mcp:sources', (_event, excludeProfileId) =>
    mcpConfig.listSources(store.list(), excludeProfileId)
  );

  handle('mcp:copy', (_event, { profileId, sourceId }) => {
    const result = mcpConfig.copyInto(profileId, sourceId);
    pushState();
    return result;
  });

  handle('profile:update', (_event, { id, name, color }) => {
    store.update(id, { name, color });
    pushState();
    return { ok: true };
  });

  handle('profile:remove', async (_event, id) => {
    await launcher.quitAndWait(id);
    const result = await store.remove(id);
    pushState();
    return result;
  });

  handle('profile:launch', async (_event, id) => {
    const result = await launcher.launch(id);
    pushState();
    return result;
  });

  handle('profile:focus', (_event, id) => launcher.focus(id));

  handle('profile:quit', (_event, id) => {
    const result = launcher.quit(id);
    pushState();
    return result;
  });

  handle('profile:reveal', (_event, id) => {
    const dir = paths.dataDirectory(id);
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
    return { ok: true };
  });

  // Each profile has its own claude_desktop_config.json, because Claude reads
  // it from inside the user-data directory. Create an empty one on demand so
  // there is always something to open.
  handle('profile:openMcpConfig', (_event, id) => {
    const dir = paths.dataDirectory(id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'claude_desktop_config.json');
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, '{\n  "mcpServers": {}\n}\n', 'utf8');
    }
    shell.openPath(file);
    return { ok: true };
  });

  handle('profile:usage', (_event, id) => store.diskUsage(id));

  handle('settings:chooseClaude', async () => {
    const isMac = process.platform === 'darwin';
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Locate Claude Desktop',
      defaultPath: isMac ? '/Applications' : process.env.LOCALAPPDATA,
      properties: ['openFile'],
      filters: isMac
        ? [{ name: 'Applications', extensions: ['app'] }]
        : [{ name: 'Programs', extensions: ['exe'] }],
    });
    if (result.canceled || !result.filePaths.length) return { ok: false };

    const chosen = result.filePaths[0];
    if (!locator.inspect(chosen)) {
      return {
        ok: false,
        error: 'That does not look like a launchable Claude Desktop.',
      };
    }
    store.setClaudePath(chosen);
    launcher.refreshInstallation();
    pushState();
    return { ok: true };
  });

  handle('settings:clearClaude', () => {
    store.setClaudePath(null);
    launcher.refreshInstallation();
    pushState();
    return { ok: true };
  });

  handle('settings:recheck', () => {
    launcher.refreshInstallation();
    pushState();
    return { ok: true };
  });

  handle('settings:revealRoot', () => {
    paths.ensureDirectories();
    shell.openPath(paths.profilesRoot());
    return { ok: true };
  });
}

// ------------------------------------------------------------- lifecycle

app.on('second-instance', () => createWindow());

app.whenReady().then(async () => {
  store = new Store();
  launcher = new Launcher(store);

  registerIPC();
  createWindow();
  createTray();

  await launcher.adopt();
  pushState();

  // One cheap timer keeps running-state, the tray, and the UI in agreement.
  statusTimer = setInterval(pushState, 2500);
  // Memory and re-adoption both cost a process spawn to read, so they share a
  // slower clock than the plain status push.
  usageTimer = setInterval(() => {
    launcher
      .refreshRunning()
      .then(() => launcher.refreshUsage())
      .then(pushState);
  }, 5000);
  launcher.refreshUsage().then(pushState);

  nativeTheme.on('updated', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor(
        nativeTheme.shouldUseDarkColors ? '#1a1917' : '#faf9f7'
      );
    }
  });

  app.on('activate', () => createWindow());
});

app.on('window-all-closed', () => {
  // Claudify keeps living in the tray / menu bar so profiles stay one click
  // away, matching how launchers behave on both platforms.
  if (process.platform !== 'darwin' && !tray) app.quit();
});

app.on('before-quit', () => {
  if (statusTimer) clearInterval(statusTimer);
  if (usageTimer) clearInterval(usageTimer);
});
