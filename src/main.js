import fs from 'node:fs';
import { config } from './config.js';
import { refreshLineup } from './lineup.js';
import { startScheduler } from './recorder.js';
import { startServer } from './server.js';
import { log } from './log.js';

fs.mkdirSync(config.recordingsDir, { recursive: true });
if (!config.m3uUrl) log('M3U_URL is not set: add it to the container environment.');

startServer();
startScheduler();
await refreshLineup();
setInterval(refreshLineup, Math.max(0.25, config.refreshHours) * 3600_000);
