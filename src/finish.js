// Turns a finished recording's .ts part(s) into one MP4 with a seek index,
// plus an .nfo and a spoiler-free thumbnail so Jellyfin and Plex never need to
// grab a frame from the video.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { cleanName, isMovie, localParts, plannedPath } from './naming.js';

export function workDirFor(id) {
  return path.join(config.recordingsDir, '.inprogress', String(id));
}

export function listParts(id) {
  const dir = workDirFor(id);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /^part-\d+\.ts$/.test(f))
    .sort()
    .map((f) => path.join(dir, f))
    .filter((f) => fs.statSync(f).size > 0);
}

function run(cmd, args, { cwd, timeoutMs = 6 * 3600_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim().split('\n').slice(-3).join(' ') || `${cmd} exited with ${code}`));
    });
  });
}

// Length and contents of a finished file.
export async function probe(file) {
  const out = await run(config.ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height',
    '-of', 'json', file], { timeoutMs: 120_000 });
  const info = JSON.parse(out);
  const streams = info.streams || [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.filter((s) => s.codec_type === 'audio').map((s) => s.codec_name);
  const codecs = [video && `${video.codec_name}${video.width ? ` ${video.width}×${video.height}` : ''}`, [...new Set(audio)].join('+')]
    .filter(Boolean).join(' · ');
  return { duration: Number(info.format?.duration) || 0, codecs };
}

export async function finishRecording(rec) {
  const work = workDirFor(rec.id);
  const parts = listParts(rec.id);
  if (!parts.length) throw new Error('Nothing was recorded.');

  const tmp = path.join(work, 'joined.mp4');
  const input = [];
  if (parts.length === 1) {
    input.push('-i', parts[0]);
  } else {
    // The concat demuxer lines the parts up end to end, so each reconnect's
    // restarted timestamps become one continuous timeline.
    const list = parts.map((p) => `file '${path.basename(p)}'`).join('\n');
    fs.writeFileSync(path.join(work, 'parts.txt'), `${list}\n`);
    input.push('-f', 'concat', '-safe', '0', '-i', 'parts.txt');
  }
  await run(config.ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-fflags', '+genpts+discardcorrupt',
    // Look further into the stream for the picture size: a part can start between keyframes.
    '-analyzeduration', '30M', '-probesize', '100M',
    ...input,
    '-map', '0:v:0?', '-map', '0:a?', '-dn', '-sn',
    '-c', 'copy',
    '-movflags', '+faststart',
    '-f', 'mp4', 'joined.mp4',
  ], { cwd: work });

  const { duration, codecs } = await probe(tmp);
  if (!(duration > 0)) throw new Error('The joined MP4 has no playable length.');

  const { dir, base, custom } = plannedPath(rec);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${base}.mp4`);
  moveFile(tmp, file);

  writeNfo(rec, dir, base, custom);
  await writeThumbnail(rec, dir, base, work, custom).catch(() => {});

  fs.rmSync(work, { recursive: true, force: true });
  return { file, size: fs.statSync(file).size, duration, codecs };
}

function moveFile(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(from, to);
    fs.rmSync(from);
  }
}

// Every file that belongs to a recording, for deleting it.
export function sidecarFiles(file) {
  if (!file) return [];
  const dir = path.dirname(file);
  const base = path.basename(file, '.mp4');
  const files = [file, `${base}.nfo`, `${base}.jpg`, `${base}-thumb.jpg`].map((f) => path.resolve(dir, f));
  if (path.basename(path.dirname(dir)) === 'Movies') files.push(path.join(dir, 'poster.jpg'));
  return files;
}

const xml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function writeNfo(rec, dir, base, custom) {
  const { date } = localParts(rec.start);
  const genre = rec.category ? `  <genre>${xml(rec.category)}</genre>\n` : '';
  let body;
  if (isMovie(rec)) {
    body = `<movie>\n  <title>${xml(rec.title)}</title>\n  <year>${date.slice(0, 4)}</year>\n  <premiered>${date}</premiered>\n`
      + `  <plot>${xml(rec.descr)}</plot>\n${genre}  <studio>${xml(rec.channel_name)}</studio>\n</movie>\n`;
  } else {
    const episode = rec.season && rec.episode ? `  <season>${rec.season}</season>\n  <episode>${rec.episode}</episode>\n` : '';
    body = `<episodedetails>\n  <title>${xml(rec.subtitle || `${rec.title} ${date}`)}</title>\n  <showtitle>${xml(rec.title)}</showtitle>\n`
      + `${episode}  <aired>${date}</aired>\n  <plot>${xml(rec.descr)}</plot>\n${genre}  <studio>${xml(rec.channel_name)}</studio>\n</episodedetails>\n`;
    // Automatic naming keeps each show in its own folder, which gets a tvshow.nfo.
    const showDir = path.basename(path.dirname(dir)) === 'TV' ? dir : path.dirname(dir);
    const showNfo = path.join(showDir, 'tvshow.nfo');
    if (!custom && !fs.existsSync(showNfo)) fs.writeFileSync(showNfo, `<tvshow>\n  <title>${xml(rec.title)}</title>\n</tvshow>\n`);
  }
  fs.writeFileSync(path.join(dir, `${base}.nfo`), `<?xml version="1.0" encoding="UTF-8"?>\n${body}`);
}

// Uses the guide's artwork for the show when it has some; otherwise draws a
// title card. Never a frame from the recording, so no scores leak.
async function writeThumbnail(rec, dir, base, work, custom) {
  const jpg = path.join(work, 'thumb.jpg');
  let made = false;
  if (rec.icon) {
    made = await run(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', rec.icon,
      '-vf', 'scale=1280:-2', '-frames:v', '1', 'thumb.jpg'], { cwd: work, timeoutMs: 60_000 }).then(() => true, () => false);
  }
  if (!made) {
    const title = rec.title.length > 44 ? `${rec.title.slice(0, 42)}…` : rec.title;
    const { date } = localParts(rec.start);
    fs.writeFileSync(path.join(work, 'line1.txt'), title);
    fs.writeFileSync(path.join(work, 'line2.txt'), rec.subtitle ? cleanName(rec.subtitle, 70) : (rec.category || ''));
    fs.writeFileSync(path.join(work, 'line3.txt'), `${rec.channel_name}  ·  ${date}`);
    const font = filterValue(config.font);
    const size = title.length > 26 ? 52 : 68;
    const text = (file, fontsize, color, y) =>
      `drawtext=fontfile='${font}':textfile=${file}:fontsize=${fontsize}:fontcolor=${color}:x=(w-text_w)/2:y=${y}`;
    await run(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=0x1b2230:s=1280x720:d=1',
      '-vf', [text('line1.txt', size, 'white', '(h/2)-110'), text('line2.txt', 38, '0xc9d3e3', '(h/2)'), text('line3.txt', 32, '0x8a97ab', '(h/2)+80')].join(','),
      '-frames:v', '1', 'thumb.jpg'], { cwd: work, timeoutMs: 60_000 });
  }
  const targets = isMovie(rec) && !custom ? [path.join(dir, 'poster.jpg')] : [path.join(dir, `${base}.jpg`), path.join(dir, `${base}-thumb.jpg`)];
  for (const t of targets) fs.copyFileSync(jpg, t);
}

function filterValue(value) {
  return value.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}
