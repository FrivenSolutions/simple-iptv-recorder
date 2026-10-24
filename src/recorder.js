// Starts recordings on time, keeps them connected through dropouts, and hands
// finished ones to finish.js. Each connection writes its own part file, so a
// reconnect never corrupts what was already recorded.
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { config } from './config.js';
import { db, getRecording, getSettings, now, updateRecording } from './db.js';
import { finishRecording, listParts, probe, sidecarFiles, workDirFor } from './finish.js';
import { notify } from './notify.js';
import { log } from './log.js';

const jobs = new Map();
const STALL_MS = 30_000;
const INCOMPLETE_AFTER_SECONDS = 60;

export const activeCount = () => jobs.size;
const windowEnd = (rec) => rec.stop + rec.post_pad * 60;
const windowStart = (rec) => rec.start - rec.pre_pad * 60;

export function startScheduler() {
  // Recordings that were running when the container stopped: carry on, or finish them.
  for (const rec of db.prepare("SELECT * FROM recordings WHERE status IN ('recording', 'processing')").all()) {
    if (rec.status === 'recording' && now() < windowEnd(rec)) startRecording(rec, { resumed: true });
    else queueFinish(rec.id);
  }
  setInterval(tick, 5_000);
  tick();
  fillMissingCodecs();
  setInterval(applyRetention, 3600_000);
  applyRetention();
}

function tick() {
  const t = now();
  const due = db.prepare("SELECT * FROM recordings WHERE status = 'scheduled' AND start - pre_pad * 60 <= ?").all(t);
  for (const rec of due) {
    if (t >= windowEnd(rec)) {
      updateRecording(rec.id, { status: 'failed', error: 'Missed: the recorder was not running at the time.', finished: t });
      notify('Recording missed', `${rec.title} on ${rec.channel_name} was missed because the recorder was not running.`);
    } else if (!jobs.has(rec.id)) {
      const limit = getSettings().maxStreams;
      if (jobs.size >= limit) {
        notify('Too many recordings at once', `${rec.title} is starting while ${jobs.size} other recordings are running `
          + `(limit ${limit}). The manager may refuse it until a stream frees up.`);
      }
      startRecording(rec);
    }
  }
}

// Runs a recording; an unexpected error ends it (keeping what was recorded) instead of the whole recorder.
function startRecording(rec, options) {
  record(rec, options).catch((err) => {
    log(`Recording #${rec.id} stopped by an error: ${err.stack || err.message}`);
    jobs.delete(rec.id);
    updateRecording(rec.id, { status: 'processing', error: `Last stream error: ${err.message}` });
    queueFinish(rec.id);
  });
}

async function record(rec, { resumed = false } = {}) {
  const job = { stop: false, discard: false, controller: null };
  jobs.set(rec.id, job);
  const work = workDirFor(rec.id);
  fs.mkdirSync(work, { recursive: true });

  let partNo = listParts(rec.id).length;
  let missing = rec.missing_seconds || 0;
  let reconnects = rec.reconnects || 0;
  let lastError = '';
  let gapStart = now();
  if (resumed && partNo) {
    // Count the time the container was down as missing.
    gapStart = Math.floor(fs.statSync(listParts(rec.id).at(-1)).mtimeMs / 1000);
  } else if (gapStart - windowStart(rec) > 30) {
    gapStart = windowStart(rec);
  }
  updateRecording(rec.id, { status: 'recording', error: null });
  log(`Recording ${resumed ? 'resumed' : 'started'}: #${rec.id} ${rec.title} on ${rec.channel_name}`);

  const row = db.prepare('SELECT url, light_url FROM channels WHERE id = ?').get(rec.channel_id);
  const channel = row && { url: rec.use_light && row.light_url ? row.light_url : row.url };
  const end = () => windowEnd(getRecording(rec.id) || rec);

  while (channel && !job.stop && now() < end()) {
    const part = path.join(work, `part-${String(partNo + 1).padStart(3, '0')}.ts`);
    const controller = new AbortController();
    job.controller = controller;
    let bytes = 0;
    let retryMs = 5_000;
    try {
      const res = await fetch(channel.url, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000 + (end() - now()) * 1000)]),
        headers: { 'User-Agent': 'simple-iptv-recorder' },
      });
      if (!res.ok) {
        res.body?.cancel().catch(() => {});
        lastError = res.status === 503 ? 'HTTP 503: the manager is at its stream limit' : `HTTP ${res.status} from the stream`;
        retryMs = res.status === 503 ? 10_000 : 15_000;
      } else {
        const out = fs.createWriteStream(part);
        out.on('error', (err) => controller.abort(new Error(`cannot write the recording: ${err.message}`)));
        let lastData = Date.now();
        const watchdog = setInterval(() => {
          if (Date.now() - lastData > STALL_MS) controller.abort(new Error(`no data for ${STALL_MS / 1000} s`));
          else if (now() >= end() || job.stop) controller.abort(new Error('finished'));
        }, 1_000);
        try {
          for await (const chunk of res.body) {
            if (!bytes && gapStart !== null) {
              missing += Math.max(0, now() - gapStart);
              gapStart = null;
              if (lastError) updateRecording(rec.id, { error: null });
            }
            bytes += chunk.length;
            lastData = Date.now();
            if (!out.write(chunk)) await once(out, 'drain');
          }
          lastError = 'the stream ended';
        } finally {
          clearInterval(watchdog);
          await new Promise((r) => { out.once('close', r); out.end(); });
        }
      }
    } catch (err) {
      const reason = controller.signal.reason?.message;
      lastError = reason && reason !== 'finished' ? reason : describeError(err);
    }

    if (bytes) partNo++;
    else fs.rmSync(part, { force: true });
    if (job.stop || now() >= end()) break;

    if (bytes) reconnects++;
    if (gapStart === null) gapStart = now();
    log(`Recording #${rec.id}: ${lastError}; reconnecting.`);
    updateRecording(rec.id, { reconnects, missing_seconds: missing, error: `Reconnecting: ${lastError}` });
    // Wait before reconnecting, but wake at once if the recording is stopped meanwhile.
    await new Promise((resolve) => {
      job.wake = resolve;
      setTimeout(resolve, Math.min(retryMs, Math.max(0, end() - now()) * 1000));
    });
    job.wake = null;
  }

  if (gapStart !== null && !job.stop) missing += Math.max(0, Math.min(now(), end()) - gapStart);
  jobs.delete(rec.id);

  if (job.discard) {
    fs.rmSync(work, { recursive: true, force: true });
    return;
  }
  if (!channel) lastError = 'the channel is no longer in the playlist';
  updateRecording(rec.id, { status: 'processing', reconnects, missing_seconds: missing, error: lastError ? `Last stream error: ${lastError}` : null });
  queueFinish(rec.id);
}

// Recordings made before codecs were stored get them filled in, one at a time.
async function fillMissingCodecs() {
  const rows = db.prepare("SELECT id, file FROM recordings WHERE file IS NOT NULL AND codecs = ''").all();
  for (const { id, file } of rows) {
    if (!fs.existsSync(file)) continue;
    try {
      updateRecording(id, { codecs: (await probe(file)).codecs || '?' });
    } catch (err) {
      log(`Could not read #${id} (${file}): ${err.message}`);
      updateRecording(id, { codecs: '?' });
    }
  }
}

function describeError(err) {
  const code = err.cause?.code || err.code || '';
  if (code === 'ECONNREFUSED') return 'the manager refused the connection (is it running?)';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'the manager\'s address could not be found';
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'the manager did not answer';
  if (code === 'UND_ERR_SOCKET' || code === 'ECONNRESET' || err.message === 'terminated') return 'the connection dropped';
  return err.cause?.message || err.message;
}

// One MP4 at a time keeps the NAS responsive.
let finishing = Promise.resolve();
function queueFinish(id) {
  finishing = finishing.then(() => finishOne(id)).catch((err) => {
    log(`Finishing #${id} failed: ${err.stack || err.message}`);
    updateRecording(id, { status: 'failed', error: `Could not finish the recording: ${err.message}`, finished: now() });
  });
  return finishing;
}

async function finishOne(id) {
  const rec = getRecording(id);
  if (!rec) return;
  if (!listParts(id).length) {
    const why = rec.error?.replace(/^(Last stream error|Reconnecting): /, '') || 'no data arrived';
    updateRecording(id, { status: 'failed', error: `Nothing was recorded: ${why}.`, finished: now() });
    fs.rmSync(workDirFor(id), { recursive: true, force: true });
    notify('Recording failed', `${rec.title} on ${rec.channel_name}: nothing was recorded (${why}).`);
    return;
  }
  updateRecording(id, { status: 'processing' });
  try {
    const result = await finishRecording(rec);
    const incomplete = rec.missing_seconds > INCOMPLETE_AFTER_SECONDS;
    const minutes = Math.round(rec.missing_seconds / 60);
    updateRecording(id, {
      status: incomplete ? 'incomplete' : 'done',
      error: incomplete ? `About ${minutes} min missing (${rec.reconnects} reconnects).` : null,
      file: result.file, size: result.size, duration: result.duration, codecs: result.codecs, finished: now(),
    });
    log(`Recording finished: #${id} → ${result.file}`);
    if (incomplete) notify('Recording incomplete', `${rec.title} on ${rec.channel_name} is missing about ${minutes} min (${rec.reconnects} reconnects).`);
    else notify('Recording done', `${rec.title} on ${rec.channel_name} is ready.`, { success: true });
  } catch (err) {
    // A few hundred KB is under a second of video: there may be no complete picture to keep.
    const bytes = listParts(id).reduce((sum, f) => sum + fs.statSync(f).size, 0);
    if (bytes < 2_000_000) {
      updateRecording(id, { status: 'failed', error: 'Too little was recorded to make a video (under a second).', finished: now() });
      notify('Recording failed', `${rec.title} on ${rec.channel_name}: too little was recorded to make a video.`);
      return;
    }
    updateRecording(id, { status: 'failed', error: `Could not make the MP4: ${err.message.replace(/[w+ @ [0-9a-fx]+] /gi, '').replace(/s+/g, ' ')}`, finished: now() });
    notify('Recording failed', `${rec.title} on ${rec.channel_name}: could not make the MP4 (${err.message}). The raw parts were kept; use Retry.`);
  }
}

export function retryFinish(id) {
  const rec = getRecording(id);
  if (!rec || rec.status !== 'failed' || !listParts(id).length) return false;
  updateRecording(id, { status: 'processing', error: null });
  queueFinish(id);
  return true;
}

export function stopRecording(id) {
  const rec = getRecording(id);
  if (!rec || rec.status !== 'recording') return false;
  // Shown as "making MP4" straight away; the recording loop winds down in the background.
  updateRecording(id, { status: 'processing' });
  const job = jobs.get(id);
  if (job) {
    job.stop = true;
    job.controller?.abort(new Error('finished'));
    job.wake?.();
  } else {
    // Marked as recording but nothing is running it (e.g. after a restart): finish what's there.
    queueFinish(id);
  }
  return true;
}

export function deleteRecording(id) {
  const rec = getRecording(id);
  if (!rec) return false;
  const job = jobs.get(id);
  if (job) {
    job.stop = true;
    job.discard = true;
    job.controller?.abort(new Error('finished'));
    job.wake?.();
  } else {
    fs.rmSync(workDirFor(id), { recursive: true, force: true });
  }
  for (const f of sidecarFiles(rec.file)) fs.rmSync(f, { force: true });
  if (rec.file) removeEmptyFolders(path.dirname(rec.file));
  db.prepare('DELETE FROM recordings WHERE id = ?').run(id);
  return true;
}

function removeEmptyFolders(dir) {
  const stopAt = [config.recordingsDir, path.join(config.recordingsDir, 'TV'), path.join(config.recordingsDir, 'Movies')].map((d) => path.resolve(d));
  let current = path.resolve(dir);
  while (!stopAt.includes(current) && current.startsWith(path.resolve(config.recordingsDir))) {
    let entries;
    try { entries = fs.readdirSync(current); } catch { return; }
    const leftovers = entries.filter((e) => e !== 'tvshow.nfo');
    if (leftovers.length) return;
    fs.rmSync(current, { recursive: true, force: true });
    current = path.dirname(current);
  }
}

// Each recording keeps its own number of days, or follows the default in Settings.
export function keepDaysOf(rec) {
  return rec.keep_days ?? getSettings().retentionDays;
}

function applyRetention() {
  const finished = db.prepare("SELECT id, title, keep_days, finished FROM recordings WHERE status IN ('done', 'incomplete')").all();
  for (const rec of finished) {
    const days = keepDaysOf(rec);
    if (!days || rec.finished >= now() - days * 86400) continue;
    deleteRecording(rec.id);
    log(`Deleted after ${days} days: #${rec.id} ${rec.title}`);
  }
}

// Recordings that would overlap the given window. "over" is true when adding
// one more would need more streams than the manager allows.
export function checkOverlap(start, end, excludeId = 0) {
  const others = db.prepare(`SELECT id, title, channel_name, start, stop, pre_pad, post_pad FROM recordings
    WHERE status IN ('scheduled', 'recording') AND id != ?
      AND start - pre_pad * 60 < ? AND stop + post_pad * 60 > ?`).all(excludeId, end, start);
  const events = [];
  for (const r of others) {
    events.push([Math.max(windowStart(r), start), 1], [Math.min(windowEnd(r), end), -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let current = 1;
  let peak = 1;
  for (const [, delta] of events) peak = Math.max(peak, (current += delta));
  const limit = getSettings().maxStreams;
  return { over: peak > limit, peak, limit, overlapping: others };
}
