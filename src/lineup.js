// Reads the manager output's M3U playlist and XMLTV guide into the database,
// then moves scheduled recordings that the guide has rescheduled.
import zlib from 'node:zlib';
import { config } from './config.js';
import { db, getSettings, now, transaction, updateRecording } from './db.js';
import { notify } from './notify.js';
import { log } from './log.js';

export const lineupState = { lastRefresh: 0, refreshing: false, error: '' };

const ATTR = /([\w-]+)="([^"]*)"/g;

export function parseM3U(text) {
  const channels = [];
  let pending = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const attrs = {};
      for (const m of line.matchAll(ATTR)) attrs[m[1].toLowerCase()] = m[2];
      const lastQuote = line.lastIndexOf('",');
      const name = (lastQuote >= 0 ? line.slice(lastQuote + 2) : line.slice(line.indexOf(',') + 1)).trim();
      pending = { attrs, name: name || attrs['tvg-name'] || '' };
    } else if (!line.startsWith('#') && pending) {
      const { attrs, name } = pending;
      const managerId = channelIdFromUrl(line) || channelIdFromUrl(attrs['tileiptv-light'] || '');
      channels.push({
        id: managerId ? `m${managerId}` : `t${attrs['tvg-id'] || name}`,
        number: attrs['tvg-chno'] !== undefined && attrs['tvg-chno'] !== '' ? Number(attrs['tvg-chno']) : null,
        name: name || attrs['tvg-name'] || 'Unnamed',
        grp: attrs['group-title'] || 'Ungrouped',
        logo: attrs['tvg-logo'] || '',
        url: line,
        // The manager's "light" link for this channel, when the output offers one.
        light_url: attrs['tileiptv-light'] || '',
        tvg_id: attrs['tvg-id'] || '',
      });
      pending = null;
    }
  }
  return channels;
}

// The manager's stream links look like /s/<token>/<channel id>.ts (or /light/...).
// Its channel id stays the same when the output changes, so schedules survive renames.
function channelIdFromUrl(url) {
  const m = url.match(/\/(?:s|light)\/[^/]+\/(\d+)\.(?:ts|m3u8)\b/);
  return m ? m[1] : '';
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function decodeXml(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, e) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : all;
      }
      return ENTITIES[e.toLowerCase()] ?? all;
    })
    .trim();
}

// XMLTV times look like "20261023220800 +0100".
export function parseXmltvTime(value) {
  const m = String(value).match(/^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?\s*([+-]\d{2}):?(\d{2})?/);
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', s = '00', tzh = '+00', tzm = '00'] = m;
  const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) / 1000;
  const offset = (Math.abs(+tzh) * 3600 + +tzm * 60) * (tzh.startsWith('-') ? -1 : 1);
  return utc - offset;
}

function parseEpisode(tags) {
  for (const { attrs, text } of tags) {
    if (attrs.system === 'xmltv_ns') {
      const [s, e] = text.split('.').map((p) => p.split('/')[0].trim());
      if (s !== '' || e !== '') {
        return { season: s !== '' && !isNaN(s) ? +s + 1 : null, episode: e !== '' && !isNaN(e) ? +e + 1 : null };
      }
    }
  }
  for (const { text } of tags) {
    const m = text.match(/S(\d+)\s*E(\d+)/i);
    if (m) return { season: +m[1], episode: +m[2] };
  }
  return { season: null, episode: null };
}

function tagsOf(inner, name) {
  const out = [];
  const re = new RegExp(`<${name}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${name}>)`, 'g');
  for (const m of inner.matchAll(re)) {
    const attrs = {};
    for (const a of m[1].matchAll(ATTR)) attrs[a[1]] = decodeXml(a[2]);
    out.push({ attrs, text: decodeXml(m[2] || '') });
  }
  return out;
}

export function* parseXMLTV(text) {
  const re = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
  for (const m of text.matchAll(re)) {
    const attrs = {};
    for (const a of m[1].matchAll(ATTR)) attrs[a[1]] = decodeXml(a[2]);
    const start = parseXmltvTime(attrs.start);
    const stop = parseXmltvTime(attrs.stop);
    if (start === null || stop === null || !attrs.channel) continue;
    const inner = m[2];
    const first = (name) => tagsOf(inner, name)[0]?.text || '';
    const icon = tagsOf(inner, 'icon')[0]?.attrs.src || '';
    yield {
      tvg_id: attrs.channel,
      start,
      stop,
      title: first('title') || 'Untitled',
      subtitle: first('sub-title'),
      descr: first('desc'),
      category: first('category'),
      year: Number(first('date').match(/^(1[89]|20)\d\d/)?.[0]) || null,
      icon,
      ...parseEpisode(tagsOf(inner, 'episode-num')),
    };
  }
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'simple-iptv-recorder' }, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`${url.replace(/\/o\/[^/]+\//, '/o/…/')} answered HTTP ${res.status}`);
  let buf = Buffer.from(await res.arrayBuffer());
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  return buf.toString('utf8');
}

export async function refreshLineup() {
  if (lineupState.refreshing) return;
  if (!config.m3uUrl) {
    lineupState.error = 'M3U_URL is not set.';
    return;
  }
  lineupState.refreshing = true;
  try {
    const channels = parseM3U(await fetchText(config.m3uUrl));
    if (!channels.length) throw new Error('The playlist has no channels.');

    transaction(() => {
      db.exec('UPDATE channels SET present = 0');
      const upsert = db.prepare(`INSERT INTO channels (id, number, name, grp, logo, url, light_url, tvg_id, sort, present)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(id) DO UPDATE SET number = excluded.number, name = excluded.name, grp = excluded.grp, logo = excluded.logo,
          url = excluded.url, light_url = excluded.light_url, tvg_id = excluded.tvg_id, sort = excluded.sort, present = 1`);
      channels.forEach((c, i) => upsert.run(c.id, c.number, c.name, c.grp, c.logo, c.url, c.light_url, c.tvg_id, i));
    });

    let programs = 0;
    if (config.epgUrl) {
      const text = await fetchText(config.epgUrl);
      const wanted = new Set(channels.map((c) => c.tvg_id).filter(Boolean));
      const cutoff = now() - 6 * 3600;
      transaction(() => {
        db.exec('DELETE FROM programs');
        const insert = db.prepare(`INSERT INTO programs (tvg_id, start, stop, title, subtitle, descr, category, season, episode, icon, year)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const p of parseXMLTV(text)) {
          if (p.stop < cutoff || !wanted.has(p.tvg_id)) continue;
          insert.run(p.tvg_id, p.start, p.stop, p.title, p.subtitle, p.descr, p.category, p.season, p.episode, p.icon, p.year);
          programs++;
        }
      });
      followGuideChanges();
    }

    lineupState.lastRefresh = now();
    lineupState.error = '';
    log(`Lineup refreshed: ${channels.length} channels, ${programs} programs.`);
  } catch (err) {
    lineupState.error = err.message;
    log(`Lineup refresh failed: ${err.message}`);
  } finally {
    lineupState.refreshing = false;
  }
}

// Channels whose recordings would skip the manager: the playlist link goes
// straight to the provider, and there is no light link to use instead (or
// light streams are not preferred).
export function lineupWarnings() {
  if (!config.m3uUrl) return [];
  const managerHost = new URL(config.m3uUrl).host;
  const preferLight = getSettings().preferLight;
  const channels = db.prepare('SELECT url, light_url FROM channels WHERE present = 1').all();
  const direct = channels.filter((c) => {
    if (preferLight && c.light_url) return false;
    try { return new URL(c.url).host !== managerHost; } catch { return true; }
  }).length;
  if (!direct) return [];
  const hasLight = channels.some((c) => c.light_url);
  return [`${direct} of ${channels.length} channels link straight to the provider instead of the manager, so recording them `
    + 'bypasses conversion and connection limits. Set this output\'s Stream mode to Proxy in the manager'
    + `${hasLight && !preferLight ? ', or turn on "Record the light stream" in Settings' : ''}.`];
}

// Words in a channel name, for telling feeds of the same event apart ("Bulls In-Arena" vs "Bucks In-Arena").
const nameWords = (name) => new Set(String(name || '').toLowerCase().match(/[a-z0-9]+/g) || []);

// The same show on another channel: the provider's event slots ("NBA 05: …") are
// reassigned between games, so a game can move to a different slot after it was scheduled.
// Prefers the same group and the channel whose name is most like the original.
function findElsewhere(rec) {
  const options = db.prepare(`SELECT p.*, c.id AS channel_id, c.name AS channel_name, c.grp FROM programs p
    JOIN channels c ON c.tvg_id = p.tvg_id AND c.present = 1
    WHERE p.title = ? AND p.start BETWEEN ? AND ? AND c.id != ?`).all(rec.title, rec.start - 4 * 3600, rec.start + 4 * 3600, rec.channel_id);
  if (!options.length) return null;
  const original = db.prepare('SELECT grp FROM channels WHERE id = ?').get(rec.channel_id);
  const words = nameWords(rec.channel_name);
  // The bracketed part names the feed, e.g. "(Wizards In-Arena)": the same feed matters most.
  const feed = (name) => (String(name || '').match(/\(([^)]*)\)\s*[^()]*$/)?.[1] || '').trim().toLowerCase();
  const score = (o) => (o.grp === original?.grp ? 100 : 0)
    + (feed(rec.channel_name) && feed(o.channel_name) === feed(rec.channel_name) ? 50 : 0)
    + [...nameWords(o.channel_name)].filter((w) => words.has(w)).length * 10
    - Math.abs(o.start - rec.start) / 3600;
  return options.sort((a, b) => score(b) - score(a))[0];
}

// A scheduled show that the guide now lists at a different time (same channel,
// same title, within 4 hours) is moved; one that moved to another channel follows it.
// One that has vanished gets a notice.
export function followGuideChanges() {
  const scheduled = db.prepare("SELECT * FROM recordings WHERE status = 'scheduled' AND from_guide = 1").all();
  const candidates = db.prepare(`SELECT * FROM programs WHERE tvg_id = ? AND title = ?
    AND start BETWEEN ? AND ? ORDER BY ABS(start - ?) LIMIT 1`);
  const coverage = db.prepare('SELECT MAX(stop) AS last FROM programs WHERE tvg_id = ?');
  const channelNow = db.prepare('SELECT tvg_id, present FROM channels WHERE id = ?');
  const when = (t) => new Date(t * 1000).toLocaleString('en-US', { timeZone: config.timeZone, dateStyle: 'medium', timeStyle: 'short' });
  for (const rec of scheduled) {
    const current = channelNow.get(rec.channel_id);
    const match = current?.present ? candidates.get(current.tvg_id, rec.title, rec.start - 4 * 3600, rec.start + 4 * 3600, rec.start) : null;
    const moved = match ? null : findElsewhere(rec);
    if (match) {
      if (match.start !== rec.start || match.stop !== rec.stop) {
        updateRecording(rec.id, { start: match.start, stop: match.stop, guide_note: `Moved by the guide from ${when(rec.start)}` });
        notify('Recording moved', `${rec.title} on ${rec.channel_name} now runs ${when(match.start)}–${when(match.stop).split(', ').pop()}.`);
      }
    } else if (moved) {
      updateRecording(rec.id, {
        channel_id: moved.channel_id, channel_name: moved.channel_name, tvg_id: moved.tvg_id,
        start: moved.start, stop: moved.stop, guide_note: `Moved by the guide from ${rec.channel_name}`,
      });
      notify('Recording moved to another channel', `${rec.title} is now on ${moved.channel_name} (was ${rec.channel_name}), ${when(moved.start)}.`);
      log(`Recording #${rec.id} followed ${rec.title} from ${rec.channel_name} to ${moved.channel_name}.`);
    } else if (!rec.guide_note?.startsWith('Not in the guide')) {
      const last = coverage.get(rec.tvg_id)?.last || 0;
      if (last >= rec.stop) {
        updateRecording(rec.id, { guide_note: 'Not in the guide any more; will still record at the original time' });
        notify('Show left the guide', `${rec.title} on ${rec.channel_name} is no longer in the guide. It will still record at the original time.`);
      }
    }
  }
}
