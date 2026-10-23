import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { db, getRecording, getSettings, now, saveSettings, updateRecording } from './db.js';
import { lineupState, refreshLineup } from './lineup.js';
import { activeCount, checkOverlap, deleteRecording, retryFinish, stopRecording } from './recorder.js';
import { notify } from './notify.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const FAVOURITES = '__favourites';

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern}$`), handler });

route('GET', '/api/status', () => ({
  lastRefresh: lineupState.lastRefresh,
  refreshing: lineupState.refreshing,
  error: lineupState.error,
  warnings: lineupState.warnings,
  channels: db.prepare('SELECT COUNT(*) AS n FROM channels WHERE present = 1').get().n,
  programmes: db.prepare('SELECT COUNT(*) AS n FROM programmes').get().n,
  recordingNow: activeCount(),
  maxStreams: config.maxStreams,
  timeZone: config.timeZone,
}));

route('GET', '/api/groups', () => {
  const groups = db.prepare(`SELECT grp AS name, COUNT(*) AS count FROM channels WHERE present = 1
    GROUP BY grp ORDER BY MIN(sort)`).all();
  const favourites = db.prepare('SELECT COUNT(*) AS n FROM channels WHERE present = 1 AND favourite = 1').get().n;
  return [{ name: FAVOURITES, label: 'Favourites', count: favourites }, ...groups.map((g) => ({ ...g, label: g.name }))];
});

const CHANNEL_ORDER = 'ORDER BY number IS NULL, number, sort';

route('GET', '/api/guide', (req, q) => {
  const start = Number(q.get('start')) || now();
  const end = start + Math.min(Number(q.get('hours')) || 4, 24) * 3600;
  const group = q.get('group') || '';
  const channels = group === FAVOURITES
    ? db.prepare(`SELECT id, number, name, grp, logo, tvg_id, favourite FROM channels WHERE present = 1 AND favourite = 1 ${CHANNEL_ORDER}`).all()
    : db.prepare(`SELECT id, number, name, grp, logo, tvg_id, favourite FROM channels WHERE present = 1 AND grp = ? ${CHANNEL_ORDER}`).all(group);
  const ids = [...new Set(channels.map((c) => c.tvg_id).filter(Boolean))];
  const programmes = {};
  const select = db.prepare(`SELECT id, tvg_id, start, stop, title, subtitle, descr, category, season, episode FROM programmes
    WHERE tvg_id = ? AND stop > ? AND start < ? ORDER BY start`);
  for (const id of ids) programmes[id] = select.all(id, start, end);
  const recordings = db.prepare(`SELECT id, channel_id, start, stop, status FROM recordings
    WHERE status IN ('scheduled', 'recording') AND stop > ? AND start < ?`).all(start, end);
  return { start, end, channels, programmes, recordings };
});

route('GET', '/api/search', (req, q) => {
  const text = (q.get('q') || '').trim();
  if (text.length < 2) return [];
  const like = `%${text.replace(/[%_]/g, (c) => `\\${c}`)}%`;
  return db.prepare(`SELECT p.id, p.tvg_id, p.start, p.stop, p.title, p.subtitle, p.descr, p.category, p.season, p.episode,
      c.id AS channel_id, c.name AS channel_name, c.number AS channel_number, c.grp
    FROM programmes p JOIN channels c ON c.tvg_id = p.tvg_id AND c.present = 1
    WHERE p.stop > ? AND (p.title LIKE ? ESCAPE '\\' OR p.subtitle LIKE ? ESCAPE '\\')
    ORDER BY p.start, c.number LIMIT 300`).all(now(), like, like);
});

route('GET', '/api/channels', (req, q) => {
  const text = (q.get('q') || '').trim();
  const like = `%${text.replace(/[%_]/g, (c) => `\\${c}`)}%`;
  return db.prepare(`SELECT id, number, name, grp FROM channels WHERE present = 1
    AND (name LIKE ? ESCAPE '\\' OR CAST(number AS TEXT) LIKE ? ESCAPE '\\') ${CHANNEL_ORDER} LIMIT 50`).all(like, like);
});

route('POST', '/api/channels/([^/]+)/favourite', (req, q, body, [id]) => {
  const result = db.prepare('UPDATE channels SET favourite = ? WHERE id = ?').run(body.favourite ? 1 : 0, decodeURIComponent(id));
  if (!result.changes) throw new HttpError(404, 'No such channel.');
  return { ok: true };
});

route('GET', '/api/recordings', (req, q) => {
  const upcoming = q.get('view') === 'upcoming';
  return db.prepare(`SELECT id, channel_id, channel_name, title, subtitle, descr, category, start, stop, pre_pad, post_pad,
      from_guide, guide_note, status, error, reconnects, missing_seconds, file, size, duration, finished
    FROM recordings WHERE status ${upcoming ? "IN ('scheduled', 'recording')" : "NOT IN ('scheduled', 'recording')"}
    ORDER BY start ${upcoming ? 'ASC' : 'DESC'}`).all()
    .map((r) => ({ ...r, file: r.file ? path.relative(config.recordingsDir, r.file) : null }));
});

route('POST', '/api/recordings', (req, q, body) => {
  const settings = getSettings();
  const channel = db.prepare('SELECT * FROM channels WHERE id = ? AND present = 1').get(body.channelId);
  if (!channel) throw new HttpError(400, 'Pick a channel.');
  const prePad = body.prePad ?? settings.prePadMin;
  const postPad = body.postPad ?? settings.postPadMin;
  if (![prePad, postPad].every((n) => Number.isInteger(n) && n >= 0 && n <= 240)) throw new HttpError(400, 'Padding must be 0–240 minutes.');

  let rec;
  if (body.programmeId) {
    const p = db.prepare('SELECT * FROM programmes WHERE id = ?').get(body.programmeId);
    if (!p) throw new HttpError(404, 'That programme is no longer in the guide. Refresh the page.');
    rec = { ...p, from_guide: 1 };
  } else {
    const start = Number(body.start);
    const stop = Number(body.stop);
    if (!start || !stop || stop <= start) throw new HttpError(400, 'The end must be after the start.');
    if (stop - start > 12 * 3600) throw new HttpError(400, 'A recording can be at most 12 hours.');
    rec = { tvg_id: channel.tvg_id, start, stop, title: (body.title || '').trim() || channel.name, from_guide: 0 };
  }
  if (rec.stop + postPad * 60 <= now()) throw new HttpError(400, 'That has already ended.');

  const duplicate = db.prepare(`SELECT id FROM recordings WHERE channel_id = ? AND start < ? AND stop > ?
    AND status IN ('scheduled', 'recording')`).get(channel.id, rec.stop, rec.start);
  if (duplicate) throw new HttpError(409, 'Something on this channel is already scheduled at that time.');

  const overlap = checkOverlap(rec.start - prePad * 60, rec.stop + postPad * 60);
  if (overlap.over && !body.force) {
    throw new HttpError(409, `This would need ${overlap.peak} streams at once; the limit is ${overlap.limit}.`, { overlap });
  }

  const result = db.prepare(`INSERT INTO recordings (channel_id, channel_name, tvg_id, title, subtitle, descr, category, season, episode, icon,
      start, stop, pre_pad, post_pad, from_guide, status, created)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)`).run(
    channel.id, channel.name, rec.tvg_id || '', rec.title, rec.subtitle || '', rec.descr || '', rec.category || '',
    rec.season ?? null, rec.episode ?? null, rec.icon || '', rec.start, rec.stop, prePad, postPad, rec.from_guide, now());
  return { id: Number(result.lastInsertRowid) };
});

route('PATCH', '/api/recordings/(\\d+)', (req, q, body, [id]) => {
  const rec = getRecording(Number(id));
  if (!rec) throw new HttpError(404, 'No such recording.');
  if (!['scheduled', 'recording'].includes(rec.status)) throw new HttpError(400, 'Only upcoming recordings can be changed.');
  const changes = {};
  for (const [key, field] of [['prePad', 'pre_pad'], ['postPad', 'post_pad']]) {
    if (body[key] === undefined) continue;
    if (!Number.isInteger(body[key]) || body[key] < 0 || body[key] > 240) throw new HttpError(400, 'Padding must be 0–240 minutes.');
    if (field === 'pre_pad' && rec.status === 'recording') continue;
    changes[field] = body[key];
  }
  updateRecording(rec.id, changes);
  return { ok: true };
});

route('DELETE', '/api/recordings/(\\d+)', (req, q, body, [id]) => {
  if (!deleteRecording(Number(id))) throw new HttpError(404, 'No such recording.');
  return { ok: true };
});

route('POST', '/api/recordings/(\\d+)/stop', (req, q, body, [id]) => {
  if (!stopRecording(Number(id))) throw new HttpError(400, 'That is not recording right now.');
  return { ok: true };
});

route('POST', '/api/recordings/(\\d+)/retry', (req, q, body, [id]) => {
  if (!retryFinish(Number(id))) throw new HttpError(400, 'There is nothing to retry for that recording.');
  return { ok: true };
});

route('GET', '/api/settings', () => getSettings());
route('PUT', '/api/settings', (req, q, body) => saveSettings(body));
route('POST', '/api/settings/test', async () => {
  const sent = await notify('Test from Simple IPTV Recorder', 'Notifications are working.');
  if (!sent.length) throw new HttpError(400, 'Nothing was sent. Check the ntfy topic URL or Pushbullet token, then save first.');
  return { sent };
});

route('POST', '/api/refresh', () => {
  refreshLineup();
  return { ok: true };
});

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new HttpError(413, 'Too large.');
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Bad JSON.'); }
}

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

// Plays a finished recording in the browser, with seeking (HTTP ranges).
function serveRecording(req, res, id) {
  const rec = getRecording(id);
  if (!rec?.file || !fs.existsSync(rec.file)) return send(res, 404, { error: 'File not found.' });
  const size = fs.statSync(rec.file).size;
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  const headers = {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.basename(rec.file))}`,
  };
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(end, size - 1);
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(rec.file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  fs.createReadStream(rec.file).pipe(res);
}

function serveStatic(res, pathname) {
  const file = path.join(publicDir, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(publicDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

export function startServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      const file = url.pathname.match(/^\/files\/(\d+)$/);
      if (file) return serveRecording(req, res, Number(file[1]));
      if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);
      for (const r of routes) {
        const m = r.method === req.method && url.pathname.match(r.re);
        if (!m) continue;
        const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
        return send(res, 200, await r.handler(req, url.searchParams, body, m.slice(1)));
      }
      throw new HttpError(404, 'Not found.');
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(err);
      send(res, err.status || 500, { error: err.message, ...(err.extra || {}) });
    }
  });
  server.listen(config.port, () => console.log(`Simple IPTV Recorder on port ${config.port}`));
  return server;
}
