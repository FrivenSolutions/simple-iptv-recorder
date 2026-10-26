// Fixed settings come from the container's environment. Settings that can be
// changed in the web page (padding, retention, notifications) start from these
// defaults and are then kept in the database.
const env = process.env;

const num = (value, fallback) => {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) ? n : fallback;
};

// The manager serves an output's guide next to its playlist:
// …/o/<token>/playlist.m3u → …/o/<token>/epg.xml
export function guideUrlFor(m3uUrl) {
  const playlist = /playlist\.m3u8?(?=\?|$)/;
  return m3uUrl && playlist.test(m3uUrl) ? m3uUrl.replace(playlist, 'epg.xml') : '';
}

export const config = {
  m3uUrl: env.M3U_URL || '',
  epgUrl: env.EPG_URL || guideUrlFor(env.M3U_URL),
  dataDir: env.DATA_DIR || '/config',
  recordingsDir: env.RECORDINGS_DIR || '/recordings',
  port: num(env.PORT, 8089),
  timeZone: env.TZ || 'UTC',
  ffmpeg: env.FFMPEG || 'ffmpeg',
  ffprobe: env.FFPROBE || 'ffprobe',
  font: env.FONT_FILE || '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
};

export const settingDefaults = {
  maxStreams: num(env.MAX_STREAMS, 4),
  refreshHours: num(env.REFRESH_HOURS, 6),
  prePadMin: num(env.PRE_PADDING_MIN, 2),
  postPadMin: num(env.POST_PADDING_MIN, 5),
  retentionDays: num(env.RETENTION_DAYS, 0),
  ntfyUrl: env.NTFY_URL || '',
  ntfyToken: env.NTFY_TOKEN || '',
  pushbulletToken: env.PUSHBULLET_TOKEN || '',
  notifyOnSuccess: env.NOTIFY_ON_SUCCESS === 'true',
  preferLight: env.PREFER_LIGHT === 'true',
  // Empty = automatic Jellyfin/Plex naming; see naming.js for the placeholders.
  fileNameTemplate: env.FILE_NAME_FORMAT || '',
  // Warn when the recordings folder has less free space than this (0 = never).
  minFreeGb: num(env.MIN_FREE_GB, 20),
  // Media servers to tell about new recordings, so they show up without waiting for a scan.
  jellyfinUrl: env.JELLYFIN_URL || '',
  jellyfinApiKey: env.JELLYFIN_API_KEY || '',
  plexUrl: env.PLEX_URL || '',
  plexToken: env.PLEX_TOKEN || '',
};
