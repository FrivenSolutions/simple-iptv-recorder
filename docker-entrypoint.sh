#!/bin/sh
# Runs the recorder as PUID:PGID (on Synology usually your user, e.g. 1026:100)
# so recordings on the NAS belong to you, not root.
set -e
PUID="${PUID:-1026}"
PGID="${PGID:-100}"
umask 002

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR" "$RECORDINGS_DIR"
  chown -R "$PUID:$PGID" "$DATA_DIR"
  if ! setpriv --reuid="$PUID" --regid="$PGID" --clear-groups test -w "$RECORDINGS_DIR"; then
    echo "WARNING: user $PUID:$PGID cannot write to $RECORDINGS_DIR. Give that user write access to the recordings share." >&2
  fi
  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups "$@"
fi
exec "$@"
