// Fixed settings come from the container's environment. Settings that can be
// changed in the web page (padding, retention, notifications) start from these
// defaults and are then kept in the database.
const env = process.env;

const num = (value, fallback) => {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) ? n : fallback;
};

export const config = {
  m3uUrl: env.M3U_URL || '',
  epgUrl: env.EPG_URL || '',
  dataDir: env.DATA_DIR || '/config',
  recordingsDir: env.RECORDINGS_DIR || '/recordings',
  port: num(env.PORT, 8089),
  maxStreams: num(env.MAX_STREAMS, 4),
  refreshHours: num(env.REFRESH_HOURS, 6),
  timeZone: env.TZ || 'UTC',
  ffmpeg: env.FFMPEG || 'ffmpeg',
  ffprobe: env.FFPROBE || 'ffprobe',
  font: env.FONT_FILE || '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
};

export const settingDefaults = {
  prePadMin: num(env.PRE_PADDING_MIN, 2),
  postPadMin: num(env.POST_PADDING_MIN, 5),
  retentionDays: num(env.RETENTION_DAYS, 0),
  ntfyUrl: env.NTFY_URL || '',
  ntfyToken: env.NTFY_TOKEN || '',
  pushbulletToken: env.PUSHBULLET_TOKEN || '',
  notifyOnSuccess: env.NOTIFY_ON_SUCCESS === 'true',
};
