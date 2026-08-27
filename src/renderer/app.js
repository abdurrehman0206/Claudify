'use strict';

const api = window.claudify;

let state = {
  platform: 'darwin',
  colors: [],
  profiles: [],
  running: {},
  unverified: [],
  installation: null,
  claudePathOverride: null,
  loadError: null,
};

let editorTarget = null; // null = creating, otherwise the profile being edited
let editorColor = 'blue';
let deleteTarget = null;
let openMenuId = null;
let dismissedError = null;

// ------------------------------------------------------------- utilities

const $ = (id) => document.getElementById(id);

function svg(paths, size = 16, filled = false) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('aria-hidden', 'true');
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  if (filled) {
    el.style.fill = 'currentColor';
    el.style.stroke = 'none';
  }
  for (const d of paths) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    el.appendChild(p);
  }
  return el;
}

const ICON = {
  warning: ['M12 9v4', 'M12 17h.01', 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z'],
  check: ['M20 6 9 17l-5-5'],
  stop: ['M7 6h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z'],
  dots: ['M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2', 'M19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2', 'M5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2'],
};

function initials(name) {
  const parts = String(name).trim().split(/\s+/).slice(0, 2);
  const letters = parts.map((p) => [...p][0] || '').join('');
  return (letters || '?').toUpperCase();
}

function relativeTime(iso) {
  if (!iso) return 'Never opened';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'Never opened';
  const seconds = Math.round((then - Date.now()) / 1000);
  const units = [
    ['year', 31536000],
    ['month', 2592000],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, span] of units) {
    if (Math.abs(seconds) >= span) {
      return `Last opened ${formatter.format(Math.round(seconds / span), unit)}`;
    }
  }
  return 'Last opened just now';
}

function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

// --------------------------------------------------------------- banners

function renderBanners() {
  const host = $('banners');
  host.textContent = '';

  if (!state.installation) {
    const banner = document.createElement('div');
    banner.className = 'banner warning';
    banner.appendChild(svg(ICON.warning));
    const body = document.createElement('div');
    body.className = 'banner-body';
    const strong = document.createElement('strong');
    strong.textContent = 'Claude Desktop was not found. ';
    body.appendChild(strong);
    body.appendChild(
      document.createTextNode(
        'Install it, or point Claudify at it from Settings.'
      )
    );
    banner.appendChild(body);
    const open = document.createElement('button');
    open.textContent = 'Open Settings';
    open.addEventListener('click', openSettings);
    banner.appendChild(open);
    host.appendChild(banner);
  }

  if (state.loadError && state.loadError !== dismissedError) {
    const banner = document.createElement('div');
    banner.className = 'banner error';
    banner.appendChild(svg(ICON.warning));
    const body = document.createElement('div');
    body.className = 'banner-body';
    body.textContent = state.loadError;
    banner.appendChild(body);
    const close = document.createElement('button');
    close.textContent = 'Dismiss';
    close.addEventListener('click', () => {
      dismissedError = state.loadError;
      renderBanners();
    });
    banner.appendChild(close);
    host.appendChild(banner);
  }
}

function showError(message) {
  if (!message) return;
  state.loadError = message;
  dismissedError = null;
  renderBanners();
}

// ----------------------------------------------------------------- cards

function buildCard(profile) {
  const running = Boolean(state.running[profile.id]);
  const unverified = state.unverified.includes(profile.id);

  const li = document.createElement('li');
  li.className = 'card';

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.dataset.color = profile.color;
  avatar.textContent = initials(profile.name);
  li.appendChild(avatar);

  const body = document.createElement('div');
  body.className = 'card-body';

  const nameRow = document.createElement('div');
  nameRow.className = 'card-name';
  const nameEl = document.createElement('span');
  nameEl.className = 'name';
  nameEl.textContent = profile.name;
  nameRow.appendChild(nameEl);
  if (running) {
    const dot = document.createElement('span');
    dot.className = 'dot';
    nameRow.appendChild(dot);
  }
  body.appendChild(nameRow);

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  meta.textContent = running
    ? `Running · pid ${state.running[profile.id].pid}`
    : relativeTime(profile.lastLaunchedAt);
  body.appendChild(meta);

  if (unverified) {
    const warn = document.createElement('div');
    warn.className = 'card-warning';
    warn.appendChild(svg(ICON.warning, 13));
    const text = document.createElement('span');
    text.textContent =
      'Claude did not write into this profile folder. It may be sharing the default session.';
    warn.appendChild(text);
    body.appendChild(warn);
  }

  li.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'card-actions';

  if (running) {
    const focus = document.createElement('button');
    focus.className = 'ghost-button';
    focus.textContent = 'Focus';
    focus.addEventListener('click', () => api.focus(profile.id));
    actions.appendChild(focus);

    const stop = document.createElement('button');
    stop.className = 'ghost-button';
    stop.title = 'Quit this instance';
    stop.setAttribute('aria-label', `Quit ${profile.name}`);
    stop.appendChild(svg(ICON.stop, 12, true));
    stop.addEventListener('click', async () => {
      const result = await api.quit(profile.id);
      if (result && result.error) showError(result.error);
    });
    actions.appendChild(stop);
  } else {
    const open = document.createElement('button');
    open.className = 'primary-button';
    open.textContent = 'Open';
    open.disabled = !state.installation;
    open.addEventListener('click', async () => {
      const result = await api.launch(profile.id);
      if (result && result.error) showError(result.error);
    });
    actions.appendChild(open);
  }

  actions.appendChild(buildMenu(profile));
  li.appendChild(actions);
  return li;
}

function buildMenu(profile) {
  const wrap = document.createElement('div');
  wrap.className = 'menu-wrap';

  const trigger = document.createElement('button');
  trigger.className = 'icon-button';
  trigger.setAttribute('aria-label', `More options for ${profile.name}`);
  trigger.appendChild(svg(ICON.dots));
  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    openMenuId = openMenuId === profile.id ? null : profile.id;
    renderList();
  });
  wrap.appendChild(trigger);

  if (openMenuId !== profile.id) return wrap;

  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.addEventListener('click', (event) => event.stopPropagation());

  const item = (label, handler, destructive = false) => {
    const button = document.createElement('button');
    button.textContent = label;
    if (destructive) button.className = 'destructive';
    button.addEventListener('click', () => {
      openMenuId = null;
      handler();
    });
    menu.appendChild(button);
  };

  item('Rename…', () => openEditor(profile));
  item('Show data folder', () => api.reveal(profile.id));
  item('Edit MCP config', () => api.openMcpConfig(profile.id));
  menu.appendChild(document.createElement('hr'));
  item('Delete profile…', () => confirmDelete(profile), true);

  wrap.appendChild(menu);
  return wrap;
}

function renderList() {
  const list = $('profile-list');
  const empty = $('empty');
  list.textContent = '';

  if (state.profiles.length === 0) {
    empty.classList.remove('hidden');
    list.classList.add('hidden');
    return;
  }

  empty.classList.add('hidden');
  list.classList.remove('hidden');
  for (const profile of state.profiles) list.appendChild(buildCard(profile));
}

function renderSubtitle() {
  const count = state.profiles.length;
  const active = Object.keys(state.running).length;
  const parts = [];
  if (count) parts.push(`${count} profile${count === 1 ? '' : 's'}`);
  if (active) parts.push(`${active} running`);
  $('subtitle').textContent = parts.length
    ? parts.join(' · ')
    : 'Separate Claude Desktop sessions, side by side.';
}

function render() {
  document.body.classList.toggle('darwin', state.platform === 'darwin');
  renderBanners();
  renderList();
  renderSubtitle();
}

// ---------------------------------------------------------------- editor

function openEditor(profile) {
  editorTarget = profile || null;
  editorColor = profile
    ? profile.color
    : state.colors[Math.floor(Math.random() * state.colors.length)] || 'blue';

  $('editor-title').textContent = profile ? 'Rename Profile' : 'New Profile';
  $('editor-save').textContent = profile ? 'Save' : 'Create';
  $('editor-hint').classList.toggle('hidden', Boolean(profile));

  const input = $('editor-name');
  input.value = profile ? profile.name : '';
  syncEditorSaveState();

  renderSwatches();
  $('editor-backdrop').classList.remove('hidden');
  input.focus();
  input.select();
}

function syncEditorSaveState() {
  $('editor-save').disabled = $('editor-name').value.trim().length === 0;
}

function renderSwatches() {
  const host = $('editor-colors');
  host.textContent = '';
  for (const color of state.colors) {
    const button = document.createElement('button');
    button.className = 'swatch avatar';
    button.dataset.color = color;
    button.type = 'button';
    button.title = color;
    button.setAttribute('aria-label', color);
    button.setAttribute('aria-pressed', String(color === editorColor));
    button.addEventListener('click', () => {
      editorColor = color;
      renderSwatches();
    });
    host.appendChild(button);
  }
}

function closeEditor() {
  $('editor-backdrop').classList.add('hidden');
  editorTarget = null;
}

async function saveEditor() {
  const name = $('editor-name').value.trim();
  if (!name) return;
  if (editorTarget) {
    await api.updateProfile({ id: editorTarget.id, name, color: editorColor });
  } else {
    await api.addProfile({ name, color: editorColor });
  }
  closeEditor();
  await refresh();
}

// -------------------------------------------------------------- settings

function openSettings() {
  renderSettings();
  $('settings-backdrop').classList.remove('hidden');
}

function renderSettings() {
  const host = $('install-status');
  host.textContent = '';

  const line = document.createElement('div');
  if (state.installation) {
    line.className = 'status-line ok';
    line.appendChild(svg(ICON.check, 14));
    const text = document.createElement('div');
    const main = document.createElement('span');
    main.textContent = state.installation.displayPath;
    text.appendChild(main);
    const detail = document.createElement('span');
    detail.className = 'detail';
    const bits = [];
    if (state.installation.version) bits.push(`Version ${state.installation.version}`);
    bits.push(
      state.installation.kind === 'msix-package'
        ? 'Store (MSIX) install'
        : state.installation.kind === 'app-bundle'
          ? 'Application bundle'
          : 'Standard install'
    );
    detail.textContent = bits.join(' · ');
    text.appendChild(detail);
    line.appendChild(text);
  } else {
    line.className = 'status-line bad';
    line.appendChild(svg(ICON.warning, 14));
    const text = document.createElement('span');
    text.textContent = 'Not found on this computer.';
    line.appendChild(text);
  }
  host.appendChild(line);

  $('clear-claude').classList.toggle('hidden', !state.claudePathOverride);
  $('data-path').textContent = state.dataPath || '';
}

function closeSettings() {
  $('settings-backdrop').classList.add('hidden');
}

// ---------------------------------------------------------------- delete

function confirmDelete(profile) {
  deleteTarget = profile;
  $('confirm-title').textContent = `Delete “${profile.name}”?`;
  $('confirm-text').textContent =
    'The signed-in session and all data for this profile move to the Trash. You can put them back until the Trash is emptied.';
  $('confirm-backdrop').classList.remove('hidden');
}

function closeConfirm() {
  $('confirm-backdrop').classList.add('hidden');
  deleteTarget = null;
}

// ------------------------------------------------------------------ wire

async function refresh() {
  const next = await api.getState();
  state = { ...state, ...next };
  render();
}

function wire() {
  $('new-btn').addEventListener('click', () => openEditor(null));
  $('empty-new-btn').addEventListener('click', () => openEditor(null));
  $('settings-btn').addEventListener('click', openSettings);

  $('editor-cancel').addEventListener('click', closeEditor);
  $('editor-save').addEventListener('click', saveEditor);
  $('editor-name').addEventListener('input', syncEditorSaveState);
  $('editor-name').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') saveEditor();
  });

  $('settings-close').addEventListener('click', closeSettings);
  $('choose-claude').addEventListener('click', async () => {
    const result = await api.chooseClaude();
    if (result && result.error) showError(result.error);
    await refresh();
    renderSettings();
  });
  $('clear-claude').addEventListener('click', async () => {
    await api.clearClaude();
    await refresh();
    renderSettings();
  });
  $('recheck-claude').addEventListener('click', async () => {
    await api.recheck();
    await refresh();
    renderSettings();
  });
  $('reveal-root').addEventListener('click', () => api.revealRoot());

  $('confirm-cancel').addEventListener('click', closeConfirm);
  $('confirm-delete').addEventListener('click', async () => {
    if (!deleteTarget) return;
    const result = await api.removeProfile(deleteTarget.id);
    closeConfirm();
    if (result && result.error) showError(result.error);
    await refresh();
  });

  // Click outside closes the open row menu; Escape closes whatever is on top.
  document.addEventListener('click', () => {
    if (openMenuId) {
      openMenuId = null;
      renderList();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!$('confirm-backdrop').classList.contains('hidden')) return closeConfirm();
    if (!$('editor-backdrop').classList.contains('hidden')) return closeEditor();
    if (!$('settings-backdrop').classList.contains('hidden')) return closeSettings();
    if (openMenuId) {
      openMenuId = null;
      renderList();
    }
  });

  for (const id of ['editor-backdrop', 'settings-backdrop', 'confirm-backdrop']) {
    $(id).addEventListener('click', (event) => {
      if (event.target.id === id) $(id).classList.add('hidden');
    });
  }

  api.onState((next) => {
    const editing = !$('editor-backdrop').classList.contains('hidden');
    state = { ...state, ...next };
    // Do not yank the list out from under an open menu or dialog.
    renderBanners();
    renderSubtitle();
    if (!editing && !openMenuId) renderList();
    if (!$('settings-backdrop').classList.contains('hidden')) renderSettings();
  });
}

wire();
refresh();
