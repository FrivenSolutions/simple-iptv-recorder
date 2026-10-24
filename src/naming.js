// Where a finished recording goes. Automatic naming uses folders Jellyfin and Plex both understand:
//   TV/<Show>/Season 01/<Show> - S01E02 - <Episode>.mp4   (guide has episode numbers)
//   TV/<Show>/<Show> - 2026-10-23 - <Episode>.mp4         (date-based: news, sports)
//   Movies/<Title> (2026)/<Title> (2026).mp4
// A custom format from Settings replaces this, e.g. "{title}/{date} {time} {title} ({channel})".
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { db, getSettings } from './db.js';

// Guide titles carry tags in superscript letters, like "Hoosiers at Wolverines ᴸᶦᵛᵉ" or "ᴺᵉʷ".
// They're useful in the guide but not in file names or library titles.
export function plainTitle(text) {
  return String(text || '')
    .replace(/[ʰ-˿ᴬ-ᵪᶛ-ᶿ⁰-₟]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanName(text, max = 120) {
  const cleaned = plainTitle(text)
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
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}${parts.minute}`,
    year: parts.year, month: parts.month, day: parts.day,
  };
}

export function isMovie(rec) {
  return /\b(movie|film)\b/i.test(rec.category || '');
}

const pad = (n) => String(n).padStart(2, '0');

// The placeholders a custom format can use, with what each one means.
export const TOKENS = {
  type: 'Movies or TV, from the guide category (like automatic naming)',
  title: 'Show or movie title',
  subtitle: 'Episode title (blank if none)',
  channel: 'Channel name',
  number: 'Channel number',
  date: 'Start date, 2026-10-24',
  time: 'Start time, 1930',
  year: 'Year, 2026',
  month: 'Month, 10',
  day: 'Day, 24',
  se: 'S01E02 (blank if the guide has no episode number)',
  season: 'Season, 01',
  episode: 'Episode, 02',
  category: 'Guide category, e.g. Sports',
  id: 'Recording number',
};

function tokenValues(rec) {
  const { date, time, year, month, day } = localParts(rec.start);
  const number = rec.channel_number ?? (rec.channel_id ? db.prepare('SELECT number FROM channels WHERE id = ?').get(rec.channel_id)?.number : null);
  const hasEpisode = rec.season && rec.episode;
  return {
    type: isMovie(rec) ? 'Movies' : 'TV',
    title: rec.title, subtitle: rec.subtitle, channel: rec.channel_name, number: number ?? '',
    date, time, year, month, day,
    se: hasEpisode ? `S${pad(rec.season)}E${pad(rec.episode)}` : '',
    season: rec.season ? pad(rec.season) : '', episode: rec.episode ? pad(rec.episode) : '',
    category: rec.category, id: rec.id ?? '',
  };
}

// Fills in a custom format. Placeholders that are blank for this recording take
// their separators with them, so "{title} - {subtitle}" never ends in " - ".
export function formatName(template, rec) {
  const values = tokenValues(rec);
  const segments = template.split(/[\\/]+/).map((segment) => {
    const filled = segment.replace(/\{(\w+)\}/g, (all, key) => {
      if (!(key in values)) return all;
      const value = String(values[key] ?? '').trim();
      return value ? cleanName(value, 100) : '\u0000';
    });
    return filled
      .replace(/\s*[-_.,·]*\s*\u0000\s*(?=[-_.,·]|$)/g, '')
      .replace(/\u0000/g, '')
      .replace(/\(\s*\)|\[\s*\]/g, '')
      .replace(/^[\s\-_.,·]+|[\s\-_.,·]+$/g, '')
      .replace(/[<>:"|?*\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }).filter((s) => s && s !== '.' && s !== '..');
  if (!segments.length) segments.push(cleanName(rec.title));
  const base = segments.pop().slice(0, 150);
  return { dir: path.join(config.recordingsDir, ...segments), base };
}

function automaticName(rec) {
  const show = cleanName(rec.title);
  const { date, year } = localParts(rec.start);
  if (isMovie(rec)) {
    const base = `${show} (${year})`;
    return { dir: path.join(config.recordingsDir, 'Movies', base), base };
  }
  const episodeTitle = rec.subtitle ? ` - ${cleanName(rec.subtitle, 80)}` : '';
  if (rec.season && rec.episode) {
    return {
      dir: path.join(config.recordingsDir, 'TV', show, `Season ${pad(rec.season)}`),
      base: `${show} - S${pad(rec.season)}E${pad(rec.episode)}${episodeTitle}`,
    };
  }
  return { dir: path.join(config.recordingsDir, 'TV', show), base: `${show} - ${date}${episodeTitle}` };
}

// Returns { dir, base, custom } where the files are dir/base.mp4, dir/base.nfo, …
export function plannedPath(rec, template = getSettings().fileNameTemplate) {
  const custom = Boolean(template?.trim());
  let { dir, base } = custom ? formatName(template.trim(), rec) : automaticName(rec);
  // Two recordings that would share a name (the same show twice a day) get the start time added.
  if (fs.existsSync(path.join(dir, `${base}.mp4`))) base = `${base} - ${localParts(rec.start).time}`;
  for (let n = 2; fs.existsSync(path.join(dir, `${base}.mp4`)); n++) base = base.replace(/ \(\d+\)$/, '') + ` (${n})`;
  return { dir, base, custom };
}
