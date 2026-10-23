# Simple IPTV Recorder

A small recorder for [Simple IPTV Manager](https://github.com/FrivenSolutions/simple-iptv-manager).
It reads one of the manager's outputs (M3U playlist + XMLTV guide), lets you pick
shows from a guide that stays usable with thousands of channels, and records
each one into **a single MP4 file** that seeks instantly in any player, Jellyfin and Plex
included.

- **No transcoding.** The manager already converts what needs converting. The recorder
  saves the stream as it arrives, then remuxes it to MP4 (`ffmpeg -c copy -movflags +faststart`).
  This puts the seek index at the front of the file. Keyframes and quality are untouched.
- **One file per recording.** While recording, each connection writes its own `.ts` part.
  After a dropout or a 503 from the manager, the recorder reconnects and starts a new part.
  At the end, the parts are joined into one MP4 with continuous timestamps, and the parts are deleted.
- **Honest status.** A recording finishes as *done*, *incomplete* (more than a minute missing,
  with how much and how many reconnects) or *failed* (with the reason). You can be notified
  through ntfy or Pushbullet.
- **Spoiler-free artwork.** Every recording gets an `.nfo` and a thumbnail made from the guide's
  artwork, or a plain title card. Nothing is ever taken from a frame of the video.
- **Guide built for big lineups.** It has a group list you can jump through (with a filter),
  favorites, a search across every channel, and a grid that only draws the rows on screen.
- One-off recordings only. Each one has start and end padding, with defaults you set once.
  You can also record by time on any channel, which helps for channels with no guide data.
- Warns when a new recording would need more streams than the manager allows. Follows the guide
  when a scheduled show moves, or tells you when it disappears. Can delete recordings after X days.

One container (Node.js + ffmpeg + SQLite), no other services.

---

## 1. Set up the manager side

In Simple IPTV Manager, create a dedicated output for recording, e.g. **Recorder**:

1. **Channels**: only the ones you might record. A smaller lineup keeps the guide fast.
2. **Stream mode: Proxy.** This matters. In any other mode, the playlist hands out the provider's
   own links (`https://<provider>/live/…`). The recorder would then bypass the manager's
   conversion and connection limits, and the recordings wouldn't show under "Watching now". The
   recorder shows a yellow banner when the playlist links don't point at the manager.
3. **Convert for playback: Only channels that need it.** H.264/H.265 + AAC pass through untouched.
   MPEG-2 or Dolby/MPEG audio (the HDHomeRun) arrive as H.264 + AAC. Either way, the MP4 plays everywhere.
4. Open **Connect your apps** and copy the **M3U** and **XMLTV** links:
   `http://192.168.1.15:8080/o/<token>/playlist.m3u` and `…/epg.xml`.

Set the recorder's `MAX_STREAMS` to the manager's limit. Use Settings → Light streams →
"At most at once" (default 4), or the provider's connection count, whichever is lower. The manager
still has the final say: when it answers *503 busy*, the recorder keeps retrying every 10 seconds
until the recording's end time.

## 2. Install on the Synology with Portainer

1. **Folders.** In File Station, create:
   - `docker/simple-iptv-recorder` (settings and schedules; back it up), and
   - a recordings folder, e.g. `media/Recordings` (Jellyfin/Plex will read it).

   Give your user read/write on both.
2. **Your user and group IDs.** Over SSH, run `id`. Synology users usually start at `uid=1026`,
   and the `users` group is `gid=100`. The container writes files as this user, so you own them.
3. **Create the stack.** In Portainer → Stacks → Add stack:
   - **Repository** (recommended): point it at this repository (push it to GitHub first;
     for a private repo, add a personal access token). Compose path: `docker-compose.yml`.
     Portainer builds the image from the `Dockerfile` here.
   - Without GitHub: copy this folder to the NAS, then over SSH run `sudo docker compose up -d --build`
     in it, with a `.env` file made from `.env.example`.
4. **Environment variables** (Portainer's stack page, or `.env`):

   | Variable | Example | Notes |
   |---|---|---|
   | `M3U_URL` | `http://192.168.1.15:8080/o/<token>/playlist.m3u` | required |
   | `EPG_URL` | `http://192.168.1.15:8080/o/<token>/epg.xml` | `epg.xml.gz` works too |
   | `RECORDINGS_PATH` | `/volume1/media/Recordings` | required |
   | `CONFIG_PATH` | `/volume1/docker/simple-iptv-recorder` | |
   | `TZ` | `America/Chicago` | used for file names and notifications |
   | `PUID` / `PGID` | `1026` / `100` | from step 2 |
   | `MAX_STREAMS` | `4` | the manager's limit |
   | `WEB_PORT` | `8089` | |

   Optional: `REFRESH_HOURS` (6), and first-run defaults for `PRE_PADDING_MIN` (2),
   `POST_PADDING_MIN` (5), `RETENTION_DAYS` (0 = keep), `NTFY_URL`, `PUSHBULLET_TOKEN`.
   After the first run, those are changed on the Settings page.
5. Deploy, then open `http://<nas-ip>:8089`. There's no login: keep it on the LAN.

Logs rotate at 10 MB × 3 files. The playlist and guide refresh on start-up, every
`REFRESH_HOURS`, and when you press **Refresh** on the Settings page.

## 3. Using it

- **Guide.** Pick a group on the left (type in *Find a group* and press Enter to jump), or use the
  drop-down on a phone. Use **☆** to make a Favorites group. Use **‹ Now ›** and the date to move in time.
  Click a show to record it. Click a channel name, or *No guide data*, to **record by time**.
- **Search** finds upcoming shows by title across every channel and group.
- **Scheduled** lists what's coming and what's recording now. Change padding, cancel, or stop early
  (stopping keeps what was recorded so far).
- **Recordings** lists finished recordings with their status. You can play one in the browser,
  delete it (files included), or **Retry** if the MP4 step failed (the raw parts are kept for that).
- **Settings** has default padding, delete-after-X-days, and notifications (with a test button).

If the guide moves a scheduled show (same channel, same title, within 4 hours), the recording
moves with it and you get a notification. If the show disappears from the guide, it still records
at the original time, and you're told.

## 4. Files, Jellyfin and Plex

```
Recordings/
  TV/
    NCAA Football/
      tvshow.nfo
      NCAA Football - 2026-10-24 - Iowa vs Ohio State.mp4
      NCAA Football - 2026-10-24 - Iowa vs Ohio State.nfo
      NCAA Football - 2026-10-24 - Iowa vs Ohio State.jpg         (Plex thumbnail)
      NCAA Football - 2026-10-24 - Iowa vs Ohio State-thumb.jpg   (Jellyfin thumbnail)
    Some Series/Season 02/Some Series - S02E05 - Title.mp4       (when the guide has episode numbers)
  Movies/
    Jackie Brown (2026)/Jackie Brown (2026).mp4 + .nfo + poster.jpg
```

Your guide has no episode numbers, so most shows are named by air date, which both servers
understand. A second airing on the same day gets the start time added (`… - 2026-10-24 - 1930.mp4`).

**Keep scores from being spoiled.** Plex and Jellyfin take a frame from the video when they find no
artwork. The recorder always provides artwork, but turn frame-grabbing off too, because both
servers also make scrubbing previews from frames:

- **Jellyfin**: mount the recordings folder into Jellyfin and add `TV` as a *Shows* library and
  `Movies` as a *Movies* library. In each library's settings:
  - keep **Nfo** checked under *Metadata savers/readers*;
  - uncheck **Screen Grabber** (and **Embedded Image Extractor**) under *Episode image fetchers*;
  - uncheck **Enable trickplay image extraction** (the scrubbing previews).
- **Plex**: add `TV` as a *TV Shows* library and `Movies` as a *Movies* library, and keep
  **Use local assets** on. Under the library's *Advanced* settings, set **Generate video preview
  thumbnails** and **Generate chapter thumbnails** to *never*. Plex uses
  `<episode>.jpg` as the episode thumbnail.

## 5. Notifications

Settings → Notifications:

- **ntfy**: the full topic URL, e.g. `https://ntfy.sh/some-long-random-name` or your own server.
  Add an access token if the topic is protected.
- **Pushbullet**: an access token from pushbullet.com → Settings → Access Tokens.

Missed, failed and incomplete recordings, guide changes, and "more recordings than streams"
are always sent. *Done* messages are optional.

## Troubleshooting

- **Yellow banner about provider links**: set the output's Stream mode to Proxy (section 1).
- **"HTTP 503: the manager is at its stream limit"**: too many streams are open at once,
  including live viewers on the same source. The recorder keeps retrying, and the time lost shows
  up as *incomplete*.
- **"cannot write the recording"** or a start-up warning about `/recordings`: give the
  `PUID`/`PGID` user write access to the recordings folder.
- **Times off by hours**: set `TZ`. Guide times carry their own offset, so only file names and
  notifications depend on it.

## Development

```bash
npm test
```

```bash
M3U_URL=http://… EPG_URL=http://… DATA_DIR=./config RECORDINGS_DIR=./recordings npm start
```

Needs Node.js 22.13+ (it uses the built-in `node:sqlite`) and `ffmpeg`/`ffprobe` on the PATH.
There are no npm dependencies.
