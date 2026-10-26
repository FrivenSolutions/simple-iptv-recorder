const $ = (sel) => document.querySelector(sel);
const FAVORITES = '__favorites';
const ROW = 56;
const SLOT = 1800;

const state = {
  groups: [],
  group: null,
  start: 0,
  hours: 3,
  guide: null,
  settings: null,
  status: null,
  tab: 'guide',
};

// ---------- helpers ----------
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    // Every change is sent as JSON, which other websites can't do without the recorder's permission.
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nowSec = () => Math.floor(Date.now() / 1000);
const fmtTime = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDay = (t) => {
  const d = new Date(t * 1000);
  const today = new Date();
  const tomorrow = new Date(Date.now() + 86400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
};
const fmtWhen = (start, stop) => `${fmtDay(start)} ${fmtTime(start)}–${fmtTime(stop)}`;
// The actual recording window, padding included.
const fmtWindow = (r) => `${fmtTime(r.start - r.pre_pad * 60)}–${fmtTime(r.stop + r.post_pad * 60)}`;
// What was really recorded, when known; otherwise the planned window.
const fmtRecorded = (r) => {
  if (!r.began || !r.ended) return `planned ${fmtWindow(r)} (${r.pre_pad} min early, ${r.post_pad} after)`;
  const early = r.ended < r.stop + r.post_pad * 60 - 60 ? ', stopped early' : '';
  return `recorded ${fmtTime(r.began)}–${fmtTime(r.ended)} (${r.pre_pad} min early, ${r.post_pad} after${early})`;
};
const fmtSize = (b) => (!b ? '' : b > 1e12 ? `${(b / 1e12).toFixed(1)} TB` : b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);
const fmtDuration = (s) => {
  if (!s) return '';
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
};
const toLocalInput = (t) => {
  const d = new Date(t * 1000);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};
const fromLocalInput = (v) => Math.floor(new Date(v).getTime() / 1000);
const remember = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
const recall = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ---------- tabs ----------
for (const btn of document.querySelectorAll('.tabs button')) {
  btn.addEventListener('click', () => showTab(btn.dataset.tab));
}
function showTab(tab) {
  state.tab = tab;
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === tab);
  for (const s of document.querySelectorAll('.tab')) s.classList.toggle('active', s.id === `tab-${tab}`);
  if (tab === 'guide') { renderRows(); loadGuide(); }
  if (tab === 'scheduled') loadScheduled();
  if (tab === 'recordings') loadRecordings();
  if (tab === 'settings') loadSettings();
}

// ---------- groups ----------
async function loadGroups() {
  state.groups = await api('GET', '/api/groups');
  const saved = recall('group');
  const fav = state.groups.find((g) => g.name === FAVORITES);
  const emptyFavorites = state.group === FAVORITES && !fav?.count && saved !== FAVORITES;
  if (!state.group || emptyFavorites || !state.groups.some((g) => g.name === state.group)) {
    state.group = state.groups.some((g) => g.name === saved) ? saved
      : fav?.count ? FAVORITES : state.groups.find((g) => g.name !== FAVORITES)?.name || FAVORITES;
  }
  renderGroups();
}

function renderGroups() {
  const filter = $('#groupFilter').value.trim().toLowerCase();
  $('#groupList').innerHTML = state.groups
    .filter((g) => !filter || g.label.toLowerCase().includes(filter))
    .map((g) => `<button data-group="${esc(g.name)}" class="${g.name === state.group ? 'active' : ''} ${g.name === FAVORITES ? 'fav' : ''}">
      <span>${g.name === FAVORITES ? '★ ' : ''}${esc(g.label)}</span><span>${g.count}</span></button>`).join('');
  $('#groupSelect').innerHTML = state.groups
    .map((g) => `<option value="${esc(g.name)}" ${g.name === state.group ? 'selected' : ''}>${g.name === FAVORITES ? '★ ' : ''}${esc(g.label)} (${g.count})</option>`).join('');
}

function pickGroup(name) {
  state.group = name;
  remember('group', name);
  $('#search').value = '';
  showResults(false);
  renderGroups();
  $('#guideBody').scrollTop = 0;
  loadGuide();
}

$('#groupList').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-group]');
  if (btn) pickGroup(btn.dataset.group);
});
$('#groupSelect').addEventListener('change', (e) => pickGroup(e.target.value));
$('#groupFilter').addEventListener('input', renderGroups);
$('#groupFilter').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const first = $('#groupList button');
    if (first) pickGroup(first.dataset.group);
  }
});

// ---------- guide ----------
function alignNow() {
  return Math.floor(nowSec() / SLOT) * SLOT;
}

async function loadGuide() {
  if (!state.group) return;
  const group = state.group;
  const data = await api('GET', `/api/guide?group=${encodeURIComponent(group)}&start=${state.start}&hours=${state.hours}`);
  if (group !== state.group) return;
  state.guide = data;
  const label = state.groups.find((g) => g.name === group)?.label || '';
  $('#groupTitle').textContent = label;
  $('#dayPick').value = toLocalInput(state.start).slice(0, 10);
  renderTicks();
  renderRows();
}

function renderTicks() {
  const span = state.hours * 3600;
  const ticks = [];
  for (let t = state.start; t < state.start + span; t += SLOT) {
    ticks.push(`<span style="left:${((t - state.start) / span) * 100}%">${fmtTime(t)}</span>`);
  }
  $('#ticks').innerHTML = ticks.join('');
}

// Only the rows on screen are drawn, so a group of thousands still scrolls smoothly.
function renderRows() {
  const g = state.guide;
  if (!g) return;
  const body = $('#guideBody');
  const rows = $('#guideRows');
  rows.style.height = `${g.channels.length * ROW}px`;
  if (!g.channels.length) {
    rows.innerHTML = `<div class="empty-state">${state.group === FAVORITES ? 'Star channels (☆) to collect them here.' : 'No channels in this group.'}</div>`;
    rows.style.height = 'auto';
    return;
  }
  const first = Math.max(0, Math.floor(body.scrollTop / ROW) - 8);
  const last = Math.min(g.channels.length, Math.ceil((body.scrollTop + body.clientHeight) / ROW) + 8);
  const html = [];
  for (let i = first; i < last; i++) html.push(rowHtml(g.channels[i], i));
  rows.innerHTML = html.join('');
}
$('#guideBody').addEventListener('scroll', () => requestAnimationFrame(renderRows));
window.addEventListener('resize', debounce(() => {
  const hours = innerWidth < 760 ? 2 : 3;
  if (hours !== state.hours) { state.hours = hours; loadGuide(); } else renderRows();
}, 150));

function rowHtml(ch, i) {
  const g = state.guide;
  const span = g.end - g.start;
  const pos = (t) => Math.min(100, Math.max(0, ((t - g.start) / span) * 100));
  const progs = (ch.tvg_id && g.programs[ch.tvg_id]) || [];
  const recs = g.recordings.filter((r) => r.channel_id === ch.id);
  const t = nowSec();
  const cells = progs.map((p) => {
    const left = pos(p.start);
    const width = pos(p.stop) - left;
    const isRec = recs.some((r) => r.start === p.start);
    const sub = p.subtitle || p.category || '';
    return `<button class="prog ${p.stop <= t ? 'past' : ''} ${isRec ? 'rec' : ''}" style="left:calc(${left}% + 2px);width:calc(${width}% - 4px)"
      data-prog="${p.id}" data-chan="${esc(ch.id)}" title="${esc(p.title)}">
      <div class="t">${esc(p.title)}</div><div class="s">${fmtTime(p.start)}${sub ? ` · ${esc(sub)}` : ''}</div></button>`;
  });
  for (const r of recs) {
    if (progs.some((p) => p.start === r.start)) continue;
    const left = pos(r.start);
    cells.push(`<div class="manual-block" style="left:${left}%;width:${pos(r.stop) - left}%">● Recording by time</div>`);
  }
  if (!progs.length) cells.unshift(`<button class="prog empty" data-manual="${esc(ch.id)}">No guide data · record by time</button>`);
  const nowLine = t >= g.start && t < g.end ? `<div class="now-line" style="left:${pos(t)}%"></div>` : '';
  return `<div class="row" style="top:${i * ROW}px">
    <div class="chan">
      <button class="star ${ch.favorite ? 'on' : ''}" data-star="${esc(ch.id)}" title="${ch.favorite ? 'Remove from favorites' : 'Add to favorites'}">${ch.favorite ? '★' : '☆'}</button>
      <span class="num">${ch.number ?? ''}</span>
      ${ch.logo ? `<img src="${esc(ch.logo)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : ''}
      <span class="name" data-manual="${esc(ch.id)}" title="${esc(ch.name)} · record by time">${esc(ch.name)}</span>
    </div>
    <div class="line">${cells.join('')}${nowLine}</div></div>`;
}

$('#guideRows').addEventListener('click', async (e) => {
  const star = e.target.closest('[data-star]');
  if (star) {
    const ch = state.guide.channels.find((c) => c.id === star.dataset.star);
    ch.favorite = ch.favorite ? 0 : 1;
    await api('POST', `/api/channels/${encodeURIComponent(ch.id)}/favorite`, { favorite: !!ch.favorite });
    await loadGroups();
    if (state.group === FAVORITES) loadGuide(); else renderRows();
    return;
  }
  const manual = e.target.closest('[data-manual]');
  if (manual) {
    openManualDialog(state.guide.channels.find((c) => c.id === manual.dataset.manual));
    return;
  }
  const prog = e.target.closest('[data-prog]');
  if (prog) {
    const ch = state.guide.channels.find((c) => c.id === prog.dataset.chan);
    const p = state.guide.programs[ch.tvg_id].find((x) => x.id === Number(prog.dataset.prog));
    openProgramDialog(p, { id: ch.id, name: ch.name, has_light: ch.has_light });
  }
});

function shift(seconds) {
  state.start = seconds === null ? alignNow() : state.start + seconds;
  loadGuide();
}
$('#earlier').addEventListener('click', () => shift(-state.hours * 1800));
$('#later').addEventListener('click', () => shift(state.hours * 1800));
$('#nowBtn').addEventListener('click', () => shift(null));
$('#dayPick').addEventListener('change', (e) => {
  if (!e.target.value) return;
  const day = new Date(`${e.target.value}T00:00`);
  const current = new Date(state.start * 1000);
  day.setHours(current.getHours(), current.getMinutes());
  state.start = Math.floor(day.getTime() / 1000);
  loadGuide();
});

// ---------- search ----------
function showResults(on) {
  $('#results').hidden = !on;
  $('#guide').hidden = on;
}
const runSearch = debounce(async () => {
  const q = $('#search').value.trim();
  if (q.length < 2) { showResults(false); return; }
  const results = await api('GET', `/api/search?q=${encodeURIComponent(q)}`);
  if ($('#search').value.trim() !== q) return;
  showResults(true);
  state.searchResults = results;
  if (!results.length) {
    $('#results').innerHTML = '<div class="empty-state">Nothing upcoming matches that.</div>';
    return;
  }
  let day = '';
  $('#results').innerHTML = results.map((p, i) => {
    const d = fmtDay(p.start);
    const head = d !== day ? `<h3>${esc((day = d))}</h3>` : '';
    return `${head}<div class="item">
      <div class="title">${esc(p.title)}${p.subtitle ? ` <span class="meta">— ${esc(p.subtitle)}</span>` : ''}</div>
      <div class="buttons"><button class="primary" data-result="${i}">Record…</button></div>
      <div class="meta">${fmtTime(p.start)}–${fmtTime(p.stop)} · ${p.channel_number ?? ''} ${esc(p.channel_name)} · ${esc(p.grp)}</div>
    </div>`;
  }).join('');
}, 250);
$('#search').addEventListener('input', runSearch);
$('#results').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-result]');
  if (!btn) return;
  const p = state.searchResults[Number(btn.dataset.result)];
  openProgramDialog(p, { id: p.channel_id, name: p.channel_name, has_light: p.has_light });
});

// ---------- dialogs ----------
const dialog = $('#dialog');
const form = $('#dialogForm');

function paddingFields(pre, post) {
  return `<div class="grid2">
    <label>Start early (min)<input name="prePad" type="number" min="0" max="240" value="${pre}"></label>
    <label>Keep going after (min)<input name="postPad" type="number" min="0" max="240" value="${post}"></label>
  </div>`;
}

function problemHtml(err) {
  const o = err.data?.overlap;
  if (!o) return esc(err.message);
  return `${esc(err.message)} Recordings at the same time:<ul>${o.overlapping
    .map((r) => `<li>${esc(r.title)} · ${esc(r.channel_name)} · ${fmtWhen(r.start, r.stop)}</li>`).join('')}</ul>`;
}

async function submitRecording(payload, button) {
  const problem = form.querySelector('.problem');
  button.disabled = true;
  try {
    await api('POST', '/api/recordings', payload);
    dialog.close();
    refreshAfterChange();
  } catch (err) {
    problem.innerHTML = problemHtml(err);
    problem.hidden = false;
    if (err.data?.overlap) {
      button.textContent = 'Record anyway';
      payload.force = true;
    }
  } finally {
    button.disabled = false;
  }
}

const KEEP_CHOICES = [0, 1, 3, 7, 14, 30, 60, 90, 180, 365];
function keepLabel(days) {
  return !days ? 'Forever' : days === 1 ? '1 day' : `${days} days`;
}
// value null follows the default in Settings.
function keepSelect(value, attrs = '') {
  const def = state.settings?.retentionDays || 0;
  const choices = value != null && !KEEP_CHOICES.includes(value) ? [...KEEP_CHOICES, value].sort((a, b) => a - b) : KEEP_CHOICES;
  return `<select ${attrs}>
    <option value="" ${value == null ? 'selected' : ''}>Default (${keepLabel(def).toLowerCase()})</option>
    ${choices.map((d) => `<option value="${d}" ${value === d ? 'selected' : ''}>${keepLabel(d)}</option>`).join('')}
  </select>`;
}
const readKeep = (select) => (select.value === '' ? null : Number(select.value));

function optionFields(showLight) {
  const light = state.settings?.preferLight;
  return `<div class="grid2">
    <label>Keep for${keepSelect(null, 'name="keepDays"')}</label>
    <label class="inline" ${showLight ? '' : 'hidden'}><span><input name="useLight" type="checkbox" ${light ? 'checked' : ''}> Record the light stream</span>
      <small>The manager's converted stream for this channel</small></label>
  </div>`;
}

function readOptions() {
  const light = form.elements.useLight;
  return {
    ...readPadding(),
    keepDays: readKeep(form.elements.keepDays),
    useLight: light && !light.closest('label').hidden ? light.checked : undefined,
  };
}

function readPadding() {
  return { prePad: Number(form.elements.prePad.value), postPad: Number(form.elements.postPad.value) };
}

async function openProgramDialog(p, ch) {
  const s = state.settings || await loadSettingsData();
  const existing = await findScheduled(ch.id, p.start);
  const episode = p.season && p.episode ? `S${String(p.season).padStart(2, '0')}E${String(p.episode).padStart(2, '0')} · ` : '';
  form.innerHTML = `
    <h2>${esc(p.title)}</h2>
    ${p.subtitle ? `<div>${episode}${esc(p.subtitle)}</div>` : ''}
    <div class="when">${fmtWhen(p.start, p.stop)} · ${esc(ch.name)}${p.category ? ` · ${esc(p.category)}` : ''}</div>
    ${p.descr ? `<div class="desc">${esc(p.descr)}</div>` : ''}
    ${existing ? `<div><span class="badge ${existing.status}">${existing.status}</span>Starts ${existing.pre_pad} min early, keeps going ${existing.post_pad} min.</div>`
      : p.stop <= nowSec() ? '<div class="when">This has already ended.</div>' : paddingFields(s.prePadMin, s.postPadMin) + optionFields(ch.has_light)}
    <div class="problem" hidden></div>
    <div class="actions">
      <button value="cancel" formnovalidate>Close</button>
      ${existing?.status === 'recording'
        ? '<button type="button" class="danger" id="dlgCancel">Stop and delete</button><button type="button" class="primary" id="dlgStop">Stop and save</button>'
        : existing ? '<button type="button" class="danger" id="dlgCancel">Cancel recording</button>'
          : p.stop > nowSec() ? '<button type="button" class="primary" id="dlgRecord">Record</button>' : ''}
    </div>`;
  form.querySelector('#dlgRecord')?.addEventListener('click', (e) => {
    submitRecording({ channelId: ch.id, programId: p.id, programStart: p.start, ...readOptions() }, e.currentTarget);
  });
  form.querySelector('#dlgStop')?.addEventListener('click', async () => {
    await api('POST', `/api/recordings/${existing.id}/stop`).catch((err) => alert(err.message));
    dialog.close();
    refreshAfterChange();
  });
  form.querySelector('#dlgCancel')?.addEventListener('click', async () => {
    if (existing.status === 'recording' && !confirm('Stop this recording and delete what was recorded so far?')) return;
    await api('DELETE', `/api/recordings/${existing.id}`);
    dialog.close();
    refreshAfterChange();
  });
  dialog.showModal();
}

async function findScheduled(channelId, start) {
  const upcoming = await api('GET', '/api/recordings?view=upcoming');
  return upcoming.find((r) => r.channel_id === channelId && r.start === start);
}

async function openManualDialog(ch) {
  const s = state.settings || await loadSettingsData();
  const start = Math.ceil(nowSec() / 300) * 300;
  let chosen = ch || null;
  form.innerHTML = `
    <h2>Record by time</h2>
    <label>Channel<input name="chanSearch" type="search" placeholder="Type a channel name or number" value="${esc(ch?.name || '')}" autocomplete="off"></label>
    <div class="pick-list" hidden></div>
    <label>Name<input name="title" placeholder="e.g. Bears vs Packers" value=""></label>
    <div class="grid2">
      <label>Start<input name="start" type="datetime-local" value="${toLocalInput(start)}" required></label>
      <label>End<input name="stop" type="datetime-local" value="${toLocalInput(start + 3 * 3600)}" required></label>
    </div>
    ${paddingFields(s.prePadMin, s.postPadMin)}
    ${optionFields(ch?.has_light)}
    <div class="problem" hidden></div>
    <div class="actions">
      <button value="cancel" formnovalidate>Close</button>
      <button type="button" class="primary" id="dlgRecord">Record</button>
    </div>`;
  const list = form.querySelector('.pick-list');
  form.elements.chanSearch.addEventListener('input', debounce(async () => {
    chosen = null;
    const q = form.elements.chanSearch.value.trim();
    if (!q) { list.hidden = true; return; }
    const found = await api('GET', `/api/channels?q=${encodeURIComponent(q)}`);
    list.hidden = !found.length;
    list.innerHTML = found.map((c, i) => `<button type="button" data-i="${i}">${c.number ?? ''} ${esc(c.name)} <small>${esc(c.grp)}</small></button>`).join('');
    list.onclick = (e) => {
      const b = e.target.closest('[data-i]');
      if (!b) return;
      chosen = found[Number(b.dataset.i)];
      form.elements.useLight.closest('label').hidden = !chosen.has_light;
      form.elements.chanSearch.value = chosen.name;
      list.hidden = true;
    };
  }, 200));
  form.querySelector('#dlgRecord').addEventListener('click', (e) => {
    const problem = form.querySelector('.problem');
    if (!chosen) {
      problem.textContent = 'Pick a channel from the list.';
      problem.hidden = false;
      return;
    }
    submitRecording({
      channelId: chosen.id,
      title: form.elements.title.value,
      start: fromLocalInput(form.elements.start.value),
      stop: fromLocalInput(form.elements.stop.value),
      ...readOptions(),
    }, e.currentTarget);
  });
  dialog.showModal();
}
$('#manualBtn').addEventListener('click', () => openManualDialog(null));

function refreshAfterChange() {
  loadStatus();
  if (state.tab === 'guide') loadGuide();
  if (state.tab === 'scheduled') loadScheduled();
}

// ---------- scheduled ----------
async function loadScheduled() {
  const list = await api('GET', '/api/recordings?view=upcoming');
  $('#scheduledCount').textContent = list.length || '';
  // Don't redraw under someone typing in a padding box; a focused button is fine.
  if (document.activeElement?.matches('#scheduledList input, #scheduledList select')) return;
  $('#scheduledList').innerHTML = list.length ? list.map((r) => {
    const live = r.status === 'recording';
    const note = [r.guide_note, live && r.error ? r.error : '', live && r.reconnects ? `${r.reconnects} reconnects` : '']
      .filter(Boolean).map(esc).join(' · ');
    return `<div class="item" data-id="${r.id}">
      <div class="title"><span class="badge ${r.status}">${live ? '● recording' : 'scheduled'}</span>${esc(r.title)}${r.subtitle ? ` <span class="meta">— ${esc(r.subtitle)}</span>` : ''}</div>
      <div class="buttons">
        ${live ? '<button class="primary" data-act="stop">Stop and save</button><button class="danger" data-act="delete">Stop and delete</button>'
          : '<button class="danger" data-act="delete">Cancel</button>'}
      </div>
      <div class="meta">${fmtWhen(r.start, r.stop)} · records ${fmtWindow(r)} · ${esc(r.channel_name)}${r.from_guide ? '' : ' · by time'}${r.use_light && live ? ' · light stream' : ''}</div>
      <div class="meta pad">Start <input type="number" min="0" max="240" value="${r.pre_pad}" data-pad="prePad" ${live ? 'disabled' : ''}> min early,
        keep going <input type="number" min="0" max="240" value="${r.post_pad}" data-pad="postPad"> min,
        keep ${keepSelect(r.keep_days, 'data-keep')}</div>
      ${r.has_light && !live ? `<label class="meta"><input type="checkbox" data-light ${r.use_light ? 'checked' : ''}> Record the light stream</label>` : ''}
      ${note ? `<div class="note warn">${note}</div>` : ''}
    </div>`;
  }).join('') : '<div class="empty-state">Nothing scheduled. Pick a show in the Guide, or record by time.</div>';
}

$('#scheduledList').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('[data-id]').dataset.id;
  try {
    if (btn.dataset.act === 'stop') await api('POST', `/api/recordings/${id}/stop`);
    if (btn.dataset.act === 'delete') {
      if (btn.textContent.includes('delete') && !confirm('Stop this recording and delete what was recorded so far?')) return;
      await api('DELETE', `/api/recordings/${id}`);
    }
  } catch (err) {
    alert(err.message);
  }
  loadScheduled();
  loadStatus();
});
async function changeKeep(e, reload) {
  const select = e.target.closest('[data-keep]');
  if (!select) return false;
  const id = select.closest('[data-id]').dataset.id;
  await api('PATCH', `/api/recordings/${id}`, { keepDays: readKeep(select) }).catch((err) => alert(err.message));
  select.blur();
  reload();
  return true;
}

$('#scheduledList').addEventListener('change', async (e) => {
  if (await changeKeep(e, loadScheduled)) return;
  const light = e.target.closest('[data-light]');
  if (light) {
    const id = light.closest('[data-id]').dataset.id;
    await api('PATCH', `/api/recordings/${id}`, { useLight: light.checked }).catch((err) => alert(err.message));
    light.blur();
    loadScheduled();
    return;
  }
  const input = e.target.closest('[data-pad]');
  if (!input) return;
  const id = input.closest('[data-id]').dataset.id;
  try {
    await api('PATCH', `/api/recordings/${id}`, { [input.dataset.pad]: Number(input.value) });
  } catch (err) {
    alert(err.message);
  }
  input.blur();
  loadScheduled();
});

// ---------- recordings ----------
async function loadRecordings() {
  state.recordings = await api('GET', '/api/recordings');
  renderRecordings();
}

// Browsers play H.264 (and usually H.265) with AAC or MP3; AC-3 audio or MPEG-2 video needs VLC or a media server.
function browserPlays(codecs) {
  if (!codecs) return true;
  const [video = '', audio = ''] = codecs.split(' · ');
  return /^(h264|hevc)\b/.test(video) && (!audio || audio.split('+').every((a) => ['aac', 'mp3'].includes(a)));
}

function renderRecordings() {
  const filter = $('#recFilter').value.trim().toLowerCase();
  const list = (state.recordings || []).filter((r) => !filter
    || `${r.title} ${r.subtitle} ${r.channel_name}`.toLowerCase().includes(filter));
  $('#recordingList').innerHTML = list.length ? list.map((r) => {
    const label = { done: 'done', incomplete: 'incomplete', failed: 'failed', processing: 'making MP4' }[r.status] || r.status;
    return `<div class="item" data-id="${r.id}">
      <div class="title"><span class="badge ${r.status}">${label}</span>${esc(r.title)}${r.subtitle ? ` <span class="meta">— ${esc(r.subtitle)}</span>` : ''}</div>
      <div class="buttons">
        ${r.file ? (browserPlays(r.codecs)
          ? `<a href="/files/${r.id}" target="_blank" rel="noopener"><button>Play</button></a>`
          : `<a href="/files/${r.id}?download=1"><button title="Your browser can't play ${esc(r.codecs)}; open it in VLC, Jellyfin or Plex">Download</button></a>`) : ''}
        ${r.status === 'failed' && /^Could not (make|finish)/.test(r.error || '') ? '<button data-act="retry">Retry</button>' : ''}
        ${r.status !== 'processing' ? '<button class="danger" data-act="delete">Delete</button>' : ''}
      </div>
      <div class="meta">${fmtWhen(r.start, r.stop)} · ${fmtRecorded(r)} · ${esc(r.channel_name)}${r.duration ? ` · ${fmtDuration(r.duration)}` : ''}${r.size ? ` · ${fmtSize(r.size)}` : ''}${r.codecs ? ` · ${esc(r.codecs)}` : ''}</div>
      ${['done', 'incomplete'].includes(r.status) ? `<div class="meta pad">Keep ${keepSelect(r.keep_days, 'data-keep')}
        ${r.delete_after ? `· deletes ${fmtDay(r.delete_after)}` : ''}</div>` : ''}
      ${r.file ? `<div class="meta">${esc(r.file)}</div>` : ''}
      ${r.error ? `<div class="note ${r.status === 'failed' ? 'err' : 'warn'}">${esc(r.error)}</div>` : ''}
    </div>`;
  }).join('') : `<div class="empty-state">${filter ? 'No recordings match.' : 'No recordings yet.'}</div>`;
}
$('#recFilter').addEventListener('input', renderRecordings);
$('#recordingList').addEventListener('change', (e) => changeKeep(e, loadRecordings));
$('#recordingList').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('[data-id]').dataset.id;
  if (btn.dataset.act === 'delete') {
    const r = state.recordings.find((x) => String(x.id) === id);
    if (!confirm(`Delete "${r.title}"${r.file ? ' and its file' : ''}?`)) return;
    await api('DELETE', `/api/recordings/${id}`);
  }
  if (btn.dataset.act === 'retry') await api('POST', `/api/recordings/${id}/retry`).catch((err) => alert(err.message));
  loadRecordings();
});

// ---------- settings ----------
async function loadSettingsData() {
  state.settings = await api('GET', '/api/settings');
  return state.settings;
}
async function loadSettings() {
  const s = await loadSettingsData();
  const f = $('#settingsForm');
  for (const [k, v] of Object.entries(s)) {
    const input = f.elements[k];
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = v; else input.value = v;
  }
  renderLineupInfo();
  previewName();
}

// File name format: clickable placeholders and a live example.
const previewName = debounce(async () => {
  const input = $('#settingsForm').elements.fileNameTemplate;
  const { tokens, examples } = await api('GET', `/api/naming?format=${encodeURIComponent(input.value)}`);
  if (!$('#tokenList').children.length) {
    $('#tokenList').innerHTML = Object.entries(tokens)
      .map(([k, help]) => `<button type="button" data-token="${k}" title="${esc(help)}">{${k}}</button>`).join('');
  }
  $('#namePreview').textContent = examples.join('\n');
}, 200);
$('#settingsForm').elements.fileNameTemplate.addEventListener('input', previewName);
$('#tokenList').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-token]');
  if (!btn) return;
  const input = $('#settingsForm').elements.fileNameTemplate;
  const at = input.selectionStart ?? input.value.length;
  const token = `{${btn.dataset.token}}`;
  input.value = input.value.slice(0, at) + token + input.value.slice(input.selectionEnd ?? at);
  input.focus();
  input.setSelectionRange(at + token.length, at + token.length);
  previewName();
});
// After a successful test, a reminder if the form holds changes that aren't saved.
function unsavedNote() {
  const saved = state.settings || {};
  const changed = Object.entries(formValues()).some(([k, v]) => k in saved && String(saved[k]) !== String(v));
  return changed ? ' Press Save to keep these settings.' : '';
}

// Everything currently in the Settings form, saved or not.
function formValues() {
  const body = {};
  for (const input of $('#settingsForm').querySelectorAll('input[name]')) {
    body[input.name] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
  }
  return body;
}
$('#settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  state.settings = await api('PUT', '/api/settings', formValues());
  $('#settingsMsg').textContent = 'Saved.';
  setTimeout(() => { $('#settingsMsg').textContent = ''; }, 2500);
});
$('#testLibrary').addEventListener('click', async () => {
  $('#libraryMsg').textContent = 'Asking…';
  try {
    const r = await api('POST', '/api/settings/test-library', formValues());
    $('#libraryMsg').textContent = `${r.reached.join(' and ')} started a rescan.${unsavedNote()}`;
  } catch (err) {
    $('#libraryMsg').textContent = err.message;
  }
});
$('#testNotify').addEventListener('click', async () => {
  try {
    const r = await api('POST', '/api/settings/test', formValues());
    $('#settingsMsg').textContent = `Sent to ${r.sent.join(' and ')}.${unsavedNote()}`;
  } catch (err) {
    $('#settingsMsg').textContent = err.message;
  }
});
// Reloads the playlist and guide from the manager, then redraws everything once it's done.
async function refreshNow() {
  const buttons = [$('#topRefresh'), $('#refreshBtn')];
  if (buttons[0].disabled) return;
  const before = state.status?.lastRefresh;
  for (const b of buttons) { b.disabled = true; b.dataset.label ??= b.textContent; b.textContent = 'Refreshing…'; }
  try {
    await api('POST', '/api/refresh');
    for (let waited = 0; waited < 180_000; waited += 1500) {
      await new Promise((r) => setTimeout(r, 1500));
      const s = await api('GET', '/api/status');
      if (!s.refreshing) {
        if (s.lastRefresh === before && s.error) alert(`Refresh failed: ${s.error}`);
        break;
      }
    }
  } catch (err) {
    alert(err.message);
  } finally {
    await loadStatus();
    for (const b of buttons) { b.disabled = false; b.textContent = b.dataset.label; }
  }
}
$('#refreshBtn').addEventListener('click', refreshNow);
$('#topRefresh').addEventListener('click', refreshNow);

function renderLineupInfo() {
  const s = state.status;
  if (!s) return;
  $('#lineupInfo').innerHTML = `${s.channels} channels, ${s.programs} guide entries.
    ${s.lastRefresh ? `Last refreshed ${fmtDay(s.lastRefresh)} ${fmtTime(s.lastRefresh)}.` : 'Not refreshed yet.'}
    At most ${s.maxStreams} recordings at once.${s.freeBytes != null ? ` ${fmtSize(s.freeBytes)} free on the recordings share.` : ''}
    Server time zone: ${esc(s.timeZone)}. Version ${esc(s.version)}.
    ${s.error ? `<div class="err">${esc(s.error)}</div>` : ''}`;
}

// ---------- status ----------
async function loadStatus() {
  try {
    state.status = await api('GET', '/api/status');
  } catch {
    $('#statusPill').textContent = 'Recorder not reachable';
    return;
  }
  const s = state.status;
  // The lineup changed (first load finished, or a refresh): redraw groups and guide.
  if (state.lastRefresh !== undefined && s.lastRefresh !== state.lastRefresh) {
    loadGroups().then(loadGuide);
  }
  state.lastRefresh = s.lastRefresh;
  const pill = $('#statusPill');
  pill.textContent = s.recordingNow ? `● Recording ${s.recordingNow} of ${s.maxStreams}` : `${s.channels} channels`;
  pill.classList.toggle('live', s.recordingNow > 0);
  const notes = [...s.warnings, ...(s.error ? [`Lineup refresh failed: ${s.error}`] : [])];
  // A closed message stays closed until its text changes.
  const dismissed = JSON.parse(recall('dismissed') || '[]');
  const shown = notes.filter((n) => !dismissed.includes(n));
  $('#banner').hidden = !shown.length;
  $('#banner').innerHTML = shown.map((n) => `<p><span>${esc(n)}</span><button class="close" data-note="${esc(n)}" title="Close">×</button></p>`).join('');
  renderLineupInfo();
  const upcoming = await api('GET', '/api/recordings?view=upcoming').catch(() => []);
  $('#scheduledCount').textContent = upcoming.length || '';
}

$('#banner').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-note]');
  if (!btn) return;
  const dismissed = JSON.parse(recall('dismissed') || '[]');
  remember('dismissed', JSON.stringify([...dismissed, btn.dataset.note].slice(-20)));
  btn.closest('p').remove();
  $('#banner').hidden = !$('#banner p');
});

setInterval(() => {
  loadStatus();
  if (state.tab === 'scheduled') loadScheduled();
  if (state.tab === 'recordings' && !document.activeElement?.matches('#tab-recordings input, #tab-recordings select')) loadRecordings();
}, 10_000);
setInterval(() => { if (state.tab === 'guide' && !$('#guide').hidden) loadGuide(); }, 60_000);

// ---------- start ----------
state.hours = innerWidth < 760 ? 2 : 3;
state.start = alignNow();
await loadStatus();
loadSettingsData();
await loadGroups();
await loadGuide();
