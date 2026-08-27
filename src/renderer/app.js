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
  usage: {},
  loadError: null,
};

let editorTarget = null; // null = creating, otherwise the profile being edited
let editorColor = 'blue';
let deleteTarget = null;
let openMenuId = null;
let dismissedError = null;
let mcpTarget = null;

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
  chevron: ['m6 9 6 6 6-6'],
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
  if (profile.kind === 'main') {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = 'your existing Claude';
    nameRow.appendChild(tag);
  }
  body.appendChild(nameRow);

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  if (running) {
    const usage = (state.usage || {})[profile.id];
    const bits = ['Running'];
    // Each instance is a full Claude, so what it costs is worth seeing before
    // you decide to keep a fourth one open.
    if (usage && usage.memoryBytes) {
      bits.push(formatBytes(usage.memoryBytes));
      bits.push(`${usage.processes} process${usage.processes === 1 ? '' : 'es'}`);
    }
    meta.textContent = bits.join(' · ');
  } else {
    meta.textContent = relativeTime(profile.lastLaunchedAt);
  }
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

  // The main profile is the Claude install you already had. Copying a config
  // over its own, or deleting it, would act on your real session rather than
  // on anything Claudify created, so neither is offered.
  if (profile.kind !== 'main') {
    item('Copy MCP config from…', () => openMcpDialog(profile));
    menu.appendChild(document.createElement('hr'));
    item('Delete profile…', () => confirmDelete(profile), true);
  }

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

  const total = Object.entries(state.usage || {})
    .filter(([id]) => state.running[id])
    .reduce((sum, [, usage]) => sum + (usage.memoryBytes || 0), 0);
  if (total) parts.push(formatBytes(total));

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

// ---------------------------------------------------------- code sessions

let activeTab = 'profiles';
let sessions = [];
let sessionsLoaded = false;
let openTarget = null;
let sessionGrouping = 'profile';
let sessionSearch = '';
let orphansOnly = false;
const collapsedGroups = new Set();
let sessionTimer = null;
let archivedSessions = [];
let retention = 30;

function switchTab(name) {
  activeTab = name;
  $('view-profiles').classList.toggle('hidden', name !== 'profiles');
  $('view-sessions').classList.toggle('hidden', name !== 'sessions');
  $('tab-profiles').setAttribute('aria-selected', String(name === 'profiles'));
  $('tab-sessions').setAttribute('aria-selected', String(name === 'sessions'));
  $('new-btn').classList.toggle('hidden', name !== 'profiles');
  if (name === 'sessions') {
    if (!sessionsLoaded) loadSessions();
    // Transcripts change while you work, so keep the list live -- but only
    // while it is on screen, and only re-reading files whose mtime moved.
    if (!sessionTimer) sessionTimer = setInterval(loadSessions, 8000);
  } else if (sessionTimer) {
    clearInterval(sessionTimer);
    sessionTimer = null;
  }
}

async function loadSessions() {
  if (!sessionsLoaded) $('sessions-status').textContent = 'Looking for Claude Code sessions…';
  const result = await api.listSessions();
  sessionsLoaded = true;

  if (!result || result.available === false) {
    sessions = [];
    $('sessions-status').textContent =
      'No Claude Code transcript store found on this computer yet.';
    renderSessions();
    return;
  }

  sessions = result.sessions || [];
  retention = result.retentionDays || 30;
  archivedSessions = (await api.listArchived()) || [];
  renderSessions();
}

function shortenPath(value) {
  if (!value) return '';
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.length <= 3 ? value : `…${value.slice(value.indexOf(parts[parts.length - 3]) - 1)}`;
}

function buildSessionRow(session) {
  const li = document.createElement('li');
  li.className = 'card session';

  const body = document.createElement('div');
  body.className = 'card-body';

  const title = document.createElement('div');
  title.className = 'card-name';
  const name = document.createElement('span');
  name.className = 'name';
  // A raw UUID tells you nothing. When neither Claude nor the transcript
  // yields a title, the project and when it last ran at least narrow it down.
  name.textContent =
    session.title ||
    (session.cwd
      ? `${projectLabel(session)} · ${relativeTime(session.lastActivityAt).replace('Last opened ', '')}`
      : session.id);
  if (!session.title) name.classList.add('untitled');
  title.appendChild(name);

  if (session.archived) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = 'archived';
    title.appendChild(tag);
  }

  // A session no profile holds is the one worth acting on: it exists on disk
  // but is in nobody's list, which is exactly what an account switch strands.
  if (session.owners.length === 0) {
    const tag = document.createElement('span');
    tag.className = 'tag accent';
    tag.textContent = 'not in any profile';
    title.appendChild(tag);
  } else {
    for (const owner of session.owners.slice(0, 3)) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = owner.label;
      title.appendChild(tag);
    }
  }
  body.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  const bits = [];
  if (session.cwd) bits.push(shortenPath(session.cwd));
  if (session.gitBranch) bits.push(session.gitBranch);
  bits.push(relativeTime(session.lastActivityAt).replace('Last opened ', ''));
  bits.push(formatBytes(session.bytes));
  meta.textContent = bits.join(' · ');
  body.appendChild(meta);

  // Claude prunes transcripts on its own schedule; once one goes there is
  // nothing left to hand to any profile, so warn while it can still be saved.
  if (session.expiresInDays <= 14) {
    const warn = document.createElement('div');
    warn.className = 'card-warning';
    warn.appendChild(svg(ICON.warning, 13));
    const text = document.createElement('span');
    text.textContent =
      session.expiresInDays === 0
        ? 'Claude may prune this transcript at any time.'
        : `Claude prunes this transcript in about ${session.expiresInDays} day${session.expiresInDays === 1 ? '' : 's'}.`;
    warn.appendChild(text);
    body.appendChild(warn);
  }

  li.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  const open = document.createElement('button');
  open.className = 'ghost-button';
  open.textContent = 'Open in…';
  open.disabled = state.profiles.length === 0 || !state.installation;
  open.addEventListener('click', () => openSessionDialog(session));
  actions.appendChild(open);
  li.appendChild(actions);

  return li;
}

function matchesSearch(session) {
  if (!sessionSearch) return true;
  const needle = sessionSearch.toLowerCase();
  return (
    (session.title || '').toLowerCase().includes(needle) ||
    (session.cwd || '').toLowerCase().includes(needle) ||
    (session.gitBranch || '').toLowerCase().includes(needle)
  );
}

function visibleSessions() {
  return sessions.filter(
    (session) =>
      matchesSearch(session) && (!orphansOnly || session.owners.length === 0)
  );
}

function projectLabel(session) {
  if (!session.cwd) return 'Unknown project';
  const parts = session.cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || session.cwd;
}

/**
 * Grouped rather than one flat list, because the question people actually have
 * is "which sessions are where" - and a session held by two profiles genuinely
 * belongs under both, so it is listed twice rather than arbitrarily assigned.
 */
function groupSessions() {
  const shown = visibleSessions();
  const groups = [];

  if (sessionGrouping === 'project') {
    const byProject = new Map();
    for (const session of shown) {
      const key = projectLabel(session);
      if (!byProject.has(key)) byProject.set(key, []);
      byProject.get(key).push(session);
    }
    for (const [label, items] of [...byProject].sort((a, b) => b[1].length - a[1].length)) {
      groups.push({ key: `project:${label}`, label, sessions: items });
    }
    return groups;
  }

  for (const profile of state.profiles) {
    const items = shown.filter((session) =>
      session.owners.some((owner) => owner.id === profile.id)
    );
    if (items.length) {
      groups.push({ key: `profile:${profile.id}`, label: profile.name, sessions: items });
    }
  }

  // Owners can name a profile Claudify no longer manages (an old install, or a
  // deleted profile). Those are still "somewhere", just not here.
  const known = new Set(state.profiles.map((p) => p.id));
  const elsewhere = shown.filter(
    (s) => s.owners.length > 0 && !s.owners.some((o) => known.has(o.id))
  );
  if (elsewhere.length) {
    groups.push({ key: 'elsewhere', label: 'In another install', sessions: elsewhere });
  }

  const orphans = shown.filter((session) => session.owners.length === 0);
  if (orphans.length) {
    groups.push({
      key: 'orphans',
      label: 'Not in any profile',
      accent: true,
      sessions: orphans,
    });
  }

  return groups;
}

function buildArchivedRow(entry) {
  const li = document.createElement('li');
  li.className = 'card session';

  const body = document.createElement('div');
  body.className = 'card-body';

  const title = document.createElement('div');
  title.className = 'card-name';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = entry.title || entry.sessionId || 'Untitled session';
  title.appendChild(name);

  const where = document.createElement('span');
  where.className = 'tag';
  where.textContent = entry.profileName;
  title.appendChild(where);
  body.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  const bits = [];
  if (entry.cwd) bits.push(shortenPath(entry.cwd));
  if (entry.lastActivityAt) {
    bits.push(relativeTime(new Date(
      typeof entry.lastActivityAt === 'number'
        ? (entry.lastActivityAt > 1e12 ? entry.lastActivityAt : entry.lastActivityAt * 1000)
        : entry.lastActivityAt
    ).toISOString()).replace('Last opened ', ''));
  }
  meta.textContent = bits.join(' · ');
  body.appendChild(meta);

  // Archiving does not protect a transcript from the pruning clock, so an old
  // archived session can come back as an entry with no conversation left.
  if (!entry.hasTranscript) {
    const warn = document.createElement('div');
    warn.className = 'card-warning';
    warn.appendChild(svg(ICON.warning, 13));
    const text = document.createElement('span');
    text.textContent =
      'Its transcript has already been pruned, so restoring brings back the entry but not the conversation.';
    warn.appendChild(text);
    body.appendChild(warn);
  }

  li.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  const restore = document.createElement('button');
  restore.className = 'ghost-button';
  restore.textContent = 'Restore';
  restore.disabled = Boolean(state.running[entry.profileId]);
  restore.title = restore.disabled
    ? `Quit ${entry.profileName} first — Claude would write its session list back over the change.`
    : 'Bring this session back into that profile';
  restore.addEventListener('click', async () => {
    const result = await api.unarchiveSession({
      file: entry.file,
      profileId: entry.profileId,
    });
    if (result && result.error) showError(result.error);
    await loadSessions();
  });
  actions.appendChild(restore);
  li.appendChild(actions);

  return li;
}

function renderSessions() {
  const host = $('session-groups');
  host.textContent = '';

  $('group-profile').setAttribute('aria-pressed', String(sessionGrouping === 'profile'));
  $('group-project').setAttribute('aria-pressed', String(sessionGrouping === 'project'));

  const orphanCount = sessions.filter((s) => s.owners.length === 0).length;
  $('sessions-status').textContent = sessions.length
    ? `${sessions.length} on this computer · ${orphanCount} in no profile · kept ${retention} days`
    : 'No sessions found yet. Use Claude Code once and they will appear here.';

  const groups = groupSessions();
  const archivedVisible = !orphansOnly && !sessionSearch && archivedSessions.length > 0;

  if (groups.length === 0 && !archivedVisible) {
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = sessions.length
      ? 'Nothing matches that filter.'
      : 'Nothing to show yet.';
    host.appendChild(note);
    return;
  }

  for (const group of groups) {
    const section = document.createElement('section');
    section.className = 'group';

    const header = document.createElement('button');
    header.className = 'group-header';
    header.setAttribute('aria-expanded', String(!collapsedGroups.has(group.key)));
    header.appendChild(svg(ICON.chevron, 13));

    const label = document.createElement('span');
    label.className = group.accent ? 'group-label accent' : 'group-label';
    label.textContent = group.label;
    header.appendChild(label);

    const count = document.createElement('span');
    count.className = 'group-count';
    count.textContent = String(group.sessions.length);
    header.appendChild(count);

    header.addEventListener('click', () => {
      if (collapsedGroups.has(group.key)) collapsedGroups.delete(group.key);
      else collapsedGroups.add(group.key);
      renderSessions();
    });
    section.appendChild(header);

    if (!collapsedGroups.has(group.key)) {
      const list = document.createElement('ul');
      list.className = 'session-list';
      for (const session of group.sessions) list.appendChild(buildSessionRow(session));
      section.appendChild(list);
    }

    host.appendChild(section);
  }

  renderArchivedGroup(host);
}

/**
 * Archived sessions come from Claude's own records rather than from
 * transcripts, because archiving is recorded there and an archived session can
 * well have outlived its transcript. Claude offers no way to bring one back.
 */
function renderArchivedGroup(host) {
  if (orphansOnly || sessionSearch || archivedSessions.length === 0) return;

  const collapsed = collapsedGroups.has('archived');
  const section = document.createElement('section');
  section.className = 'group';

  const header = document.createElement('button');
  header.className = 'group-header';
  header.setAttribute('aria-expanded', String(!collapsed));
  header.appendChild(svg(ICON.chevron, 13));

  const label = document.createElement('span');
  label.className = 'group-label';
  label.textContent = 'Archived';
  header.appendChild(label);

  const count = document.createElement('span');
  count.className = 'group-count';
  count.textContent = String(archivedSessions.length);
  header.appendChild(count);

  header.addEventListener('click', () => {
    if (collapsed) collapsedGroups.delete('archived');
    else collapsedGroups.add('archived');
    renderSessions();
  });
  section.appendChild(header);

  if (!collapsed) {
    const list = document.createElement('ul');
    list.className = 'session-list';
    for (const entry of archivedSessions) list.appendChild(buildArchivedRow(entry));
    section.appendChild(list);
  }

  host.appendChild(section);
}

function openSessionDialog(session) {
  openTarget = session;
  $('open-summary').textContent = session.title || session.id;

  const owns = (id) => session.owners.some((owner) => owner.id === id);

  const options = state.profiles.map((profile) => ({
    value: profile.id,
    label: profile.name,
    // A profile that already holds the session has nothing to import, so
    // offering it would only cost a pointless launch.
    meta: owns(profile.id)
      ? 'already has this session'
      : launcher_isRunning(profile.id)
        ? 'running'
        : 'not running',
    disabled: owns(profile.id),
  }));

  const first = options.find((option) => !option.disabled);
  dropdownFor('open-profile').set(options, first ? first.value : null);

  // Handing the session over means launching Claude again for that profile so
  // its own instance receives the link. That launcher quits itself once the
  // running instance takes over, but it is visible for a few seconds first.
  const target = state.profiles.find((p) => !owns(p.id) && launcher_isRunning(p.id));
  $('open-note').textContent = target
    ? 'Claude is already open for that profile, so the session appears in the window you have. A second Claude icon shows for a few seconds while the handover happens, then closes itself.'
    : 'Claude opens for that profile with the session already loaded.';

  $('open-backdrop').classList.remove('hidden');
}

function launcher_isRunning(id) {
  return Boolean(state.running && state.running[id]);
}

function closeOpenDialog() {
  $('open-backdrop').classList.add('hidden');
  openTarget = null;
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

  // Only offered when creating: renaming should never silently rewrite the
  // profile's MCP servers.
  $('editor-mcp-field').classList.toggle('hidden', Boolean(profile));
  if (!profile) {
    populateSources('editor-mcp', 'editor-mcp-hint', {
      excludeProfileId: null,
      includeNone: true,
    });
  }

  const input = $('editor-name');
  input.value = profile ? profile.name : '';
  syncEditorSaveState();

  renderSwatches();
  $('editor-backdrop').classList.remove('hidden');
  input.focus();
  input.select();
}

// -------------------------------------------------------------- dropdown

// A native <select> renders with the OS popup, which looks nothing like the
// rest of the app. This is a real listbox instead: same visual language as the
// row menus, and it keeps the keyboard behaviour a select would have given us.
let openDropdown = null;

function createDropdown(host) {
  host.textContent = '';
  host.classList.add('dropdown');

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'dropdown-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');

  const valueLabel = document.createElement('span');
  valueLabel.className = 'dropdown-value';
  trigger.appendChild(valueLabel);
  trigger.appendChild(svg(ICON.chevron, 14));

  const panel = document.createElement('div');
  panel.className = 'dropdown-panel';
  panel.setAttribute('role', 'listbox');
  panel.hidden = true;

  host.append(trigger, panel);

  let options = [];
  let value = null;
  let active = -1;
  let onChange = null;

  const selectable = () => options.filter((option) => !option.disabled);

  function paint() {
    const chosen = options.find((option) => option.value === value);
    valueLabel.textContent = chosen ? chosen.label : 'Select…';
    valueLabel.classList.toggle('placeholder', !chosen);

    panel.textContent = '';
    options.forEach((option, index) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'dropdown-option';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(option.value === value));
      if (option.disabled) item.setAttribute('aria-disabled', 'true');
      item.disabled = Boolean(option.disabled);
      item.classList.toggle('active', index === active);

      const text = document.createElement('span');
      text.className = 'dropdown-option-text';

      const label = document.createElement('span');
      label.className = 'dropdown-option-label';
      label.textContent = option.label;
      text.appendChild(label);

      if (option.meta) {
        const meta = document.createElement('span');
        meta.className = 'dropdown-option-meta';
        meta.textContent = option.meta;
        text.appendChild(meta);
      }

      item.appendChild(text);
      if (option.value === value) item.appendChild(svg(ICON.check, 14));

      item.addEventListener('click', (event) => {
        event.stopPropagation();
        if (option.disabled) return;
        commit(option.value);
        close();
        trigger.focus();
      });
      item.addEventListener('mousemove', () => {
        active = index;
        highlight();
      });

      panel.appendChild(item);
    });
  }

  function highlight() {
    [...panel.children].forEach((child, index) => {
      child.classList.toggle('active', index === active);
    });
    const current = panel.children[active];
    if (current) current.scrollIntoView({ block: 'nearest' });
  }

  function commit(next) {
    if (next === value) return;
    value = next;
    paint();
    if (onChange) onChange(value);
  }

  function open() {
    if (!options.length) return;
    if (openDropdown && openDropdown !== close) openDropdown();
    openDropdown = close;
    panel.hidden = false;
    host.dataset.open = 'true';
    trigger.setAttribute('aria-expanded', 'true');
    active = options.findIndex((option) => option.value === value);
    if (active < 0) active = options.findIndex((option) => !option.disabled);
    highlight();
  }

  function close() {
    panel.hidden = true;
    host.dataset.open = 'false';
    trigger.setAttribute('aria-expanded', 'false');
    if (openDropdown === close) openDropdown = null;
  }

  function step(direction) {
    if (panel.hidden) return open();
    const usable = selectable();
    if (!usable.length) return;
    let index = active;
    do {
      index = (index + direction + options.length) % options.length;
    } while (options[index].disabled);
    active = index;
    highlight();
  }

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    panel.hidden ? open() : close();
  });

  host.addEventListener('keydown', (event) => {
    switch (event.key) {
      case 'Escape':
        if (!panel.hidden) {
          event.stopPropagation(); // let the dropdown close, not the dialog
          close();
          trigger.focus();
        }
        return;
      case 'ArrowDown':
        event.preventDefault();
        step(1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        step(-1);
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (panel.hidden) return open();
        if (options[active] && !options[active].disabled) {
          commit(options[active].value);
          close();
          trigger.focus();
        }
        return;
      case 'Tab':
        close();
    }
  });

  return {
    set(nextOptions, nextValue, handler) {
      options = nextOptions;
      value = nextValue;
      onChange = handler || null;
      active = -1;
      close();
      paint();
    },
    get value() {
      return value;
    },
    close,
  };
}

const dropdowns = new Map();

function dropdownFor(id) {
  if (!dropdowns.has(id)) dropdowns.set(id, createDropdown($(id)));
  return dropdowns.get(id);
}

// ------------------------------------------------------------ MCP config

function describeSource(source) {
  if (!source.available) {
    return source.invalid
      ? 'That file is not valid JSON, so it cannot be copied.'
      : 'No MCP configuration found here yet.';
  }
  if (source.servers.length === 0) return 'Configuration found, but no servers in it.';
  return `${source.servers.length} server${source.servers.length === 1 ? '' : 's'}: ${source.servers.join(', ')}`;
}

function sourceMeta(source) {
  if (!source.available) return source.invalid ? 'invalid file' : 'none found';
  const count = source.servers.length;
  return count === 1 ? '1 server' : `${count} servers`;
}

/** Fills a dropdown with copy sources. */
async function populateSources(hostId, hintId, { excludeProfileId, includeNone }) {
  const sources = await api.mcpSources(excludeProfileId);
  const hint = $(hintId);

  const options = sources.map((source) => ({
    value: source.id,
    label: source.label,
    meta: sourceMeta(source),
    disabled: !source.available,
  }));

  if (includeNone) {
    options.unshift({ value: '', label: 'Start empty', meta: 'no servers' });
  }

  // Default to the main install, but only when it has servers worth copying.
  const main = sources.find((source) => source.id === 'main');
  let value;
  if (main && main.available && main.servers.length > 0) {
    value = 'main';
  } else if (includeNone) {
    value = '';
  } else {
    const usable = sources.find((source) => source.available);
    value = usable ? usable.id : null;
  }

  const sync = (selected) => {
    const chosen = sources.find((source) => source.id === selected);
    hint.textContent = chosen
      ? describeSource(chosen)
      : 'No servers are copied. You can add them later.';
  };

  dropdownFor(hostId).set(options, value, sync);
  sync(value);

  return sources;
}

function openMcpDialog(profile) {
  mcpTarget = profile;
  $('mcp-target').textContent = `Into “${profile.name}”. This replaces that profile's current MCP servers.`;
  populateSources('mcp-source', 'mcp-source-hint', {
    excludeProfileId: profile.id,
    includeNone: false,
  });
  $('mcp-backdrop').classList.remove('hidden');
}

function closeMcpDialog() {
  $('mcp-backdrop').classList.add('hidden');
  mcpTarget = null;
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
    const result = await api.addProfile({
      name,
      color: editorColor,
      copyMcpFrom: dropdownFor('editor-mcp').value || null,
    });
    if (result && result.mcp && result.mcp.error) showError(result.mcp.error);
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

  $('group-profile').addEventListener('click', () => {
    sessionGrouping = 'profile';
    renderSessions();
  });
  $('group-project').addEventListener('click', () => {
    sessionGrouping = 'project';
    renderSessions();
  });
  $('filter-orphans').addEventListener('change', (event) => {
    orphansOnly = event.target.checked;
    renderSessions();
  });
  $('session-search').addEventListener('input', (event) => {
    sessionSearch = event.target.value.trim();
    renderSessions();
  });

  $('tab-profiles').addEventListener('click', () => switchTab('profiles'));
  $('tab-sessions').addEventListener('click', () => switchTab('sessions'));

  $('open-cancel').addEventListener('click', closeOpenDialog);
  $('open-confirm').addEventListener('click', async () => {
    if (!openTarget) return;
    const profileId = dropdownFor('open-profile').value;
    if (!profileId) return closeOpenDialog();
    const result = await api.openSession({ profileId, sessionId: openTarget.id });
    closeOpenDialog();
    if (result && result.error) showError(result.error);
    else switchTab('profiles');
    await refresh();
  });

  $('mcp-cancel').addEventListener('click', closeMcpDialog);
  $('mcp-confirm').addEventListener('click', async () => {
    if (!mcpTarget) return;
    const sourceId = dropdownFor('mcp-source').value;
    if (!sourceId) return closeMcpDialog();
    const result = await api.copyMcp({ profileId: mcpTarget.id, sourceId });
    closeMcpDialog();
    if (result && result.error) showError(result.error);
    await refresh();
  });

  $('confirm-cancel').addEventListener('click', closeConfirm);
  $('confirm-delete').addEventListener('click', async () => {
    if (!deleteTarget) return;
    const result = await api.removeProfile(deleteTarget.id);
    closeConfirm();
    if (result && result.error) showError(result.error);
    await refresh();
  });

  // Click outside closes the open dropdown or row menu; Escape closes whatever
  // is on top.
  document.addEventListener('click', () => {
    if (openDropdown) openDropdown();
    if (openMenuId) {
      openMenuId = null;
      renderList();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!$('confirm-backdrop').classList.contains('hidden')) return closeConfirm();
    if (!$('mcp-backdrop').classList.contains('hidden')) return closeMcpDialog();
    if (!$('open-backdrop').classList.contains('hidden')) return closeOpenDialog();
    if (!$('editor-backdrop').classList.contains('hidden')) return closeEditor();
    if (!$('settings-backdrop').classList.contains('hidden')) return closeSettings();
    if (openMenuId) {
      openMenuId = null;
      renderList();
    }
  });

  for (const id of ['editor-backdrop', 'settings-backdrop', 'confirm-backdrop', 'mcp-backdrop', 'open-backdrop']) {
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
    if (!editing && !openMenuId && activeTab === 'profiles') renderList();
    if (!$('settings-backdrop').classList.contains('hidden')) renderSettings();
  });
}

wire();
refresh();
