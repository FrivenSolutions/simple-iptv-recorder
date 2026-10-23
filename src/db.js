import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config, settingDefaults } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(path.join(config.dataDir, 'recorder.db'));

db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  number REAL,
  name TEXT,
  grp TEXT,
  logo TEXT,
  url TEXT,
  tvg_id TEXT,
  sort INTEGER,
  favourite INTEGER NOT NULL DEFAULT 0,
  present INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS programmes (
  id INTEGER PRIMARY KEY,
  tvg_id TEXT,
  start INTEGER,
  stop INTEGER,
  title TEXT,
  subtitle TEXT,
  descr TEXT,
  category TEXT,
  season INTEGER,
  episode INTEGER,
  icon TEXT
);
CREATE INDEX IF NOT EXISTS programmes_channel ON programmes (tvg_id, start);
CREATE TABLE IF NOT EXISTS recordings (
  id INTEGER PRIMARY KEY,
  channel_id TEXT,
  channel_name TEXT,
  tvg_id TEXT,
  title TEXT,
  subtitle TEXT,
  descr TEXT,
  category TEXT,
  season INTEGER,
  episode INTEGER,
  icon TEXT,
  start INTEGER,
  stop INTEGER,
  pre_pad INTEGER,
  post_pad INTEGER,
  from_guide INTEGER NOT NULL DEFAULT 0,
  guide_note TEXT,
  status TEXT NOT NULL,
  error TEXT,
  reconnects INTEGER NOT NULL DEFAULT 0,
  missing_seconds INTEGER NOT NULL DEFAULT 0,
  file TEXT,
  size INTEGER,
  duration REAL,
  created INTEGER,
  finished INTEGER
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

export const now = () => Math.floor(Date.now() / 1000);

export function getSettings() {
  const out = { ...settingDefaults };
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    if (row.key in out) out[row.key] = JSON.parse(row.value);
  }
  return out;
}

export function saveSettings(changes) {
  const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [key, value] of Object.entries(changes)) {
    if (!(key in settingDefaults)) continue;
    const typed = typeof settingDefaults[key] === 'number' ? Math.max(0, Number(value) || 0)
      : typeof settingDefaults[key] === 'boolean' ? Boolean(value) : String(value ?? '').trim();
    set.run(key, JSON.stringify(typed));
  }
  return getSettings();
}

export function getRecording(id) {
  return db.prepare('SELECT * FROM recordings WHERE id = ?').get(id);
}

export function updateRecording(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  db.prepare(`UPDATE recordings SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map((k) => fields[k] ?? null), id);
}

export function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
