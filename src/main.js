import fs from 'node:fs';
import { config } from './config.js';
import { getSettings } from './db.js';
import { refreshLineup } from './lineup.js';
import { startScheduler } from './recorder.js';
import { startServer } from './server.js';
import { log } from './log.js';

fs.mkdirSync(config.recordingsDir, { recursive: true });
if (!config.m3uUrl) log('M3U_URL is not set: add it to the container environment.');

startServer();
startScheduler();
await refreshLineup();
// Re-read the interval each time, so a change on the Settings page applies to the next refresh.
const scheduleRefresh = () => setTimeout(async () => {
  await refreshLineup();
  scheduleRefresh();
}, Math.max(0.25, getSettings().refreshHours || 6) * 3600_000);
scheduleRefresh();
