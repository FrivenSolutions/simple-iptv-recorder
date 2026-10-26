// Sends a short message to ntfy and/or Pushbullet, whichever is configured.
import { getSettings } from './db.js';
import { log } from './log.js';

// `settings` lets the Settings page's test button try values that aren't saved yet.
export async function notify(title, message, { success = false, settings } = {}) {
  const s = { ...getSettings(), ...settings };
  if (success && !s.notifyOnSuccess) return { sent: [], errors: [] };
  const sent = [];
  const errors = [];
  const jobs = [];
  const attempt = (name, url, options) => post(name, url, options)
    .then(() => sent.push(name), (err) => errors.push(`${name}: ${err.message}`));
  if (s.ntfyUrl) {
    const headers = { Title: asciiHeader(title), Tags: success ? 'white_check_mark' : 'warning' };
    if (s.ntfyToken) headers.Authorization = `Bearer ${s.ntfyToken}`;
    jobs.push(attempt('ntfy', s.ntfyUrl, { method: 'POST', headers, body: message }));
  }
  if (s.pushbulletToken) {
    jobs.push(attempt('Pushbullet', 'https://api.pushbullet.com/v2/pushes', {
      method: 'POST',
      headers: { 'Access-Token': s.pushbulletToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'note', title, body: message }),
    }));
  }
  await Promise.all(jobs);
  return { sent, errors };
}

async function post(name, url, options) {
  try {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) }).catch((err) => {
      throw new Error(`could not be reached (${err.cause?.code || err.message})`);
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 401 || res.status === 403 ? ' (check the token)' : ''}`);
  } catch (err) {
    log(`${name} notification failed: ${err.message}`);
    throw err;
  }
}

// HTTP headers must be plain ASCII; ntfy shows the rest of the message as UTF-8.
function asciiHeader(text) {
  return text.normalize('NFKD').replace(/[^\x20-\x7e]/g, '');
}
