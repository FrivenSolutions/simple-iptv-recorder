import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-test-'));
process.env.DATA_DIR = path.join(tmp, 'config');
process.env.RECORDINGS_DIR = path.join(tmp, 'recordings');
process.env.TZ = 'America/Chicago';

const { parseM3U, parseXMLTV, parseXmltvTime } = await import('../src/lineup.js');
const { plannedPath, cleanName } = await import('../src/naming.js');

test('reads channels from the manager playlist', () => {
  const m3u = `#EXTM3U
#EXTINF:-1 tvg-id="HBO.us" tvg-name="HBO" tvg-logo="http://x/hbo.png" tvg-chno="2105" group-title="US | Movies",HBO
http://192.168.1.15:8080/s/abc123/2194.ts
#EXTINF:-1 tvg-id="" tvg-name="NCAA 01: A, B" group-title="Sports | NCAA Football",NCAA 01: A, B
http://192.168.1.15:8080/s/abc123/3001.ts
`;
  const [hbo, ncaa] = parseM3U(m3u);
  assert.equal(hbo.id, 'm2194');
  assert.equal(hbo.number, 2105);
  assert.equal(hbo.grp, 'US | Movies');
  assert.equal(hbo.tvg_id, 'HBO.us');
  assert.equal(ncaa.name, 'NCAA 01: A, B');
  assert.equal(ncaa.number, null);
});

test('uses the manager channel id from the light link when the stream link is direct', () => {
  const m3u = `#EXTINF:-1 tvg-id="A.us" tileiptv-light="https://iptv.example/light/tok/2178.ts",A
https://provider.example/live/u/p/438892.ts
`;
  assert.equal(parseM3U(m3u)[0].id, 'm2178');
});

test('reads guide times with their offset', () => {
  assert.equal(parseXmltvTime('20261023220800 +0100'), Date.UTC(2026, 9, 23, 21, 8) / 1000);
  assert.equal(parseXmltvTime('20261023220800 -0500'), Date.UTC(2026, 9, 24, 3, 8) / 1000);
});

test('reads programs, episode numbers and entities', () => {
  const xml = `<tv><programme start="20261023200000 +0000" stop="20261023210000 +0000" channel="HBO.us">
    <title>Tom &amp; Jerry</title><sub-title>Pilot</sub-title><desc>x</desc><category>Series</category>
    <episode-num system="xmltv_ns">1.4.</episode-num><icon src="http://x/p.jpg"/></programme></tv>`;
  const [p] = [...parseXMLTV(xml)];
  assert.equal(p.title, 'Tom & Jerry');
  assert.equal(p.season, 2);
  assert.equal(p.episode, 5);
  assert.equal(p.icon, 'http://x/p.jpg');
});

test('names files the way Jellyfin and Plex expect', () => {
  const start = Date.UTC(2026, 9, 24, 0, 30) / 1000; // 19:30 on the 23rd in Chicago
  const dated = plannedPath({ title: 'NFL: Bears @ Packers', start, category: 'Sports' });
  assert.equal(path.relative(process.env.RECORDINGS_DIR, dated.dir), path.join('TV', 'NFL Bears @ Packers'));
  assert.equal(dated.base, 'NFL Bears @ Packers - 2026-10-23');
  const ep = plannedPath({ title: 'Show', subtitle: 'Pilot', season: 1, episode: 2, start });
  assert.equal(ep.base, 'Show - S01E02 - Pilot');
  assert.match(ep.dir, /Season 01$/);
  const movie = plannedPath({ title: 'Jackie Brown', category: 'Movie', start });
  assert.equal(movie.base, 'Jackie Brown (2026)');
  assert.equal(cleanName('a/b:c?'), 'a b c');
});

test('finds the guide next to the playlist', async () => {
  const { guideUrlFor } = await import('../src/config.js');
  assert.equal(guideUrlFor('http://192.168.1.15:8080/o/tok/playlist.m3u'), 'http://192.168.1.15:8080/o/tok/epg.xml');
  assert.equal(guideUrlFor('http://x/other.m3u'), '');
});

test('fills in a custom file name format', async () => {
  const { formatName } = await import('../src/naming.js');
  const start = Date.UTC(2026, 9, 24, 0, 30) / 1000; // 19:30 on the 23rd in Chicago
  const rec = { title: 'NFL: Bears @ Packers', channel_name: 'FOX', channel_number: 205, start, category: 'Sports', id: 7 };
  const rel = (r) => path.join(path.relative(process.env.RECORDINGS_DIR, r.dir), `${r.base}`);
  assert.equal(rel(formatName('{date} {time} {title} ({channel})', rec)), '2026-10-23 1930 NFL Bears @ Packers (FOX)');
  assert.equal(rel(formatName('{title} - {se} - {subtitle}', rec)), 'NFL Bears @ Packers');
  assert.equal(rel(formatName('Sports/{year}/{title} [{subtitle}]', rec)), path.join('Sports', '2026', 'NFL Bears @ Packers'));
  assert.equal(rel(formatName('{title} {se}', { ...rec, season: 3, episode: 4 })), 'NFL Bears @ Packers S03E04');
  assert.equal(rel(formatName('../{title}', rec)), 'NFL Bears @ Packers');
  assert.equal(rel(formatName('{type}/{title}', rec)), path.join('TV', 'NFL Bears @ Packers'));
  assert.equal(rel(formatName('{type}/{title}', { ...rec, category: 'Movie' })), path.join('Movies', 'NFL Bears @ Packers'));
});
