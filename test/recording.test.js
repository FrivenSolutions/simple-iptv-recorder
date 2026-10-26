// End to end: the real app records from a fake manager whose stream drops and then
// answers 503 once, and must still produce one seekable MP4. Needs ffmpeg on the PATH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('records through a dropout and a 503 into one MP4', { skip: !hasFfmpeg && 'ffmpeg not installed', timeout: 120_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-e2e-'));
  const source = path.join(tmp, 'source.ts');
  spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=25',
    '-f', 'lavfi', '-i', 'sine=f=440:r=48000', '-t', '60', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25',
    '-c:a', 'aac', '-f', 'mpegts', source]);
  const ts = fs.readFileSync(source);
  const perTick = Math.floor(ts.length / 60 / 10 / 188) * 188; // real time, in 100 ms steps

  // Fake manager: connection 1 drops after 4 s, connection 2 is refused with 503.
  let connections = 0;
  const manager = http.createServer((req, res) => {
    if (req.url.endsWith('playlist.m3u')) {
      return res.end(`#EXTM3U\n#EXTINF:-1 tvg-id="T" group-title="Test",Test\nhttp://127.0.0.1:${manager.address().port}/s/tok/1.ts\n`);
    }
    if (req.url.endsWith('epg.xml')) return res.end('<tv></tv>');
    const n = ++connections;
    if (n === 2) { res.writeHead(503); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'video/mp2t' });
    let pos = 0;
    const started = Date.now();
    const timer = setInterval(() => {
      res.write(ts.subarray(pos, pos + perTick));
      pos = (pos + perTick) % ts.length;
      if (n === 1 && Date.now() - started > 4000) { clearInterval(timer); res.destroy(); }
    }, 100);
    req.on('close', () => clearInterval(timer));
  });
  await new Promise((r) => manager.listen(0, '127.0.0.1', r));

  const port = 18000 + Math.floor(Math.random() * 1000);
  const app = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.js'], {
    cwd: root,
    env: {
      ...process.env,
      M3U_URL: `http://127.0.0.1:${manager.address().port}/o/tok/playlist.m3u`,
      DATA_DIR: path.join(tmp, 'config'),
      RECORDINGS_DIR: path.join(tmp, 'recordings'),
      PORT: String(port),
      ...(process.platform === 'win32' ? { FONT_FILE: 'C:/Windows/Fonts/arial.ttf' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // The app's log is shown if the test fails.
  let appLog = '';
  app.stdout.on('data', (d) => { appLog += d; });
  app.stderr.on('data', (d) => { appLog += d; });
  const api = async (method, url, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method, headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
    });
    return res.json();
  };

  try {
    for (let i = 0; i < 50; i++) {
      const status = await api('GET', '/api/status').catch(() => null);
      if (status?.channels) break;
      await sleep(200);
    }
    const now = Math.floor(Date.now() / 1000);
    const { id } = await api('POST', '/api/recordings', { channelId: 'm1', title: 'E2E', start: now, stop: now + 40, prePad: 0, postPad: 0 });
    assert.ok(id, 'recording was scheduled');

    let rec;
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      rec = (await api('GET', '/api/recordings')).find((r) => r.id === id);
      if (rec && ['done', 'incomplete', 'failed'].includes(rec.status)) break;
    }
    assert.ok(['done', 'incomplete'].includes(rec?.status), `finished as ${rec?.status}: ${rec?.error}`);
    assert.ok(rec.reconnects >= 1, 'the dropout was noticed');
    // About 40 s of window, minus the scheduler pick-up, the dropout retry and the 10 s wait after the 503.
    assert.ok(rec.duration > 15, `MP4 is ${rec.duration} s long`);
    assert.match(rec.codecs, /^h264 320×240 · aac$/);

    const mp4 = path.join(tmp, 'recordings', rec.file);
    const head = fs.readFileSync(mp4).subarray(0, 64).toString('latin1');
    assert.ok(head.indexOf('moov') !== -1 && head.indexOf('moov') < head.indexOf('mdat') || !head.includes('mdat'),
      'the seek index (moov) comes before the media (faststart)');
    assert.equal(fs.readdirSync(path.join(tmp, 'recordings', '.inprogress')).length, 0, 'the raw parts were cleaned up');
  } catch (err) {
    console.log(`--- recorder log ---\n${appLog}`);
    throw err;
  } finally {
    app.kill();
    manager.close();
  }
});
