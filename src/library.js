// Free space on the recordings share, and telling Jellyfin/Plex about new files.
import fs from 'node:fs';
import { config } from './config.js';
import { getSettings, now } from './db.js';
import { notify } from './notify.js';
import { log } from './log.js';

export function freeBytes() {
  try {
    const s = fs.statfsSync(config.recordingsDir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

export function formatBytes(bytes) {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}

// A warning while space is below the limit in Settings, or null.
export function lowSpaceWarning() {
  const limit = getSettings().minFreeGb;
  const free = freeBytes();
  if (!limit || free === null || free >= limit * 1e9) return null;
  return `Only ${formatBytes(free)} free on the recordings share (warning below ${limit} GB). `
    + 'Delete recordings or set a shorter "Keep for".';
}

// Sent at most twice a day, and when a recording is about to start.
let lastLowNotice = 0;
export function checkSpace({ starting } = {}) {
  const warning = lowSpaceWarning();
  if (!warning || (!starting && now() - lastLowNotice < 12 * 3600)) return;
  lastLowNotice = now();
  notify('Recordings share is nearly full', warning);
}

async function call(name, url, options) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) }).catch((err) => {
    throw new Error(`${name} could not be reached at ${new URL(url).origin} (${err.cause?.code || err.message})`);
  });
  if (!res.ok) throw new Error(`${name} answered HTTP ${res.status}${res.status === 401 ? ' (check the key/token)' : ''}`);
}

// Recordings finishing or being deleted close together share one rescan.
let pending = null;
export function scheduleLibraryRefresh() {
  clearTimeout(pending);
  pending = setTimeout(() => refreshLibraries().catch(() => {}), 30_000);
}

// Asks each configured server to rescan its libraries. Returns the servers reached.
export async function refreshLibraries() {
  const s = getSettings();
  const base = (url) => url.replace(/\/+$/, '');
  const jobs = [];
  if (s.jellyfinUrl && s.jellyfinApiKey) {
    jobs.push(call('Jellyfin', `${base(s.jellyfinUrl)}/Library/Refresh`, {
      method: 'POST',
      headers: { Authorization: `MediaBrowser Token="${s.jellyfinApiKey}"` },
    }).then(() => 'Jellyfin'));
  }
  if (s.plexUrl && s.plexToken) {
    jobs.push(call('Plex', `${base(s.plexUrl)}/library/sections/all/refresh`, {
      headers: { 'X-Plex-Token': s.plexToken },
    }).then(() => 'Plex'));
  }
  const results = await Promise.allSettled(jobs);
  for (const r of results) if (r.status === 'rejected') log(`Library refresh failed: ${r.reason.message}`);
  return {
    reached: results.filter((r) => r.status === 'fulfilled').map((r) => r.value),
    errors: results.filter((r) => r.status === 'rejected').map((r) => r.reason.message),
  };
}
