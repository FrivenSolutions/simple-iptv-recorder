// Sends a short message to ntfy and/or Pushbullet, whichever is configured.
import { getSettings } from './db.js';
import { log } from './log.js';

export async function notify(title, message, { success = false } = {}) {
  const s = getSettings();
  if (success && !s.notifyOnSuccess) return [];
  const sent = [];
  const jobs = [];
  if (s.ntfyUrl) {
    const headers = { Title: asciiHeader(title), Tags: success ? 'white_check_mark' : 'warning' };
    if (s.ntfyToken) headers.Authorization = `Bearer ${s.ntfyToken}`;
    jobs.push(post('ntfy', s.ntfyUrl, { method: 'POST', headers, body: message }).then(() => sent.push('ntfy')));
  }
  if (s.pushbulletToken) {
    jobs.push(post('Pushbullet', 'https://api.pushbullet.com/v2/pushes', {
      method: 'POST',
      headers: { 'Access-Token': s.pushbulletToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'note', title, body: message }),
    }).then(() => sent.push('Pushbullet')));
  }
  await Promise.allSettled(jobs);
  return sent;
}

async function post(name, url, options) {
  try {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    log(`${name} notification failed: ${err.message}`);
    throw err;
  }
}

// HTTP headers must be plain ASCII; ntfy shows the rest of the message as UTF-8.
function asciiHeader(text) {
  return text.normalize('NFKD').replace(/[^\x20-\x7e]/g, '');
}
