// Where a finished recording goes, in folders Jellyfin and Plex both understand:
//   TV/<Show>/Season 01/<Show> - S01E02 - <Episode>.mp4   (guide has episode numbers)
//   TV/<Show>/<Show> - 2026-10-23 - <Episode>.mp4         (date-based: news, sports)
//   Movies/<Title> (2026)/<Title> (2026).mp4
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export function cleanName(text, max = 120) {
  const cleaned = String(text || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  return cleaned.slice(0, max).trim() || 'Untitled';
}

export function localParts(epoch) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(epoch * 1000)).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}${parts.minute}`, year: parts.year };
}

export function isMovie(rec) {
  return /\b(movie|film)\b/i.test(rec.category || '');
}

// Returns { dir, base } where the files are dir/base.mp4, dir/base.nfo, …
export function plannedPath(rec) {
  const show = cleanName(rec.title);
  const { date, time, year } = localParts(rec.start);
  const pad = (n) => String(n).padStart(2, '0');
  let dir;
  let base;
  if (isMovie(rec)) {
    base = `${show} (${year})`;
    dir = path.join(config.recordingsDir, 'Movies', base);
  } else if (rec.season && rec.episode) {
    dir = path.join(config.recordingsDir, 'TV', show, `Season ${pad(rec.season)}`);
    base = `${show} - S${pad(rec.season)}E${pad(rec.episode)}${rec.subtitle ? ` - ${cleanName(rec.subtitle, 80)}` : ''}`;
  } else {
    dir = path.join(config.recordingsDir, 'TV', show);
    base = `${show} - ${date}${rec.subtitle ? ` - ${cleanName(rec.subtitle, 80)}` : ''}`;
  }
  // Two recordings that would share a name (the same show twice a day) get the start time added.
  if (fs.existsSync(path.join(dir, `${base}.mp4`))) base = `${base} - ${time}`;
  for (let n = 2; fs.existsSync(path.join(dir, `${base}.mp4`)); n++) base = base.replace(/ \(\d+\)$/, '') + ` (${n})`;
  return { dir, base };
}
