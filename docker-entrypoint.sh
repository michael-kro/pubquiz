#!/bin/sh
# Turns the PUBQUIZ_* environment variables into command-line options.
set -e
# Inside the container it must listen on all addresses, or the published port could not reach it. Who can reach it from
# outside is decided by how the port is published: 127.0.0.1:3000:3000 keeps it on this computer, which is what we want.
set -- --no-open --port 3000 --bind 0.0.0.0 --quizzes /data/quizzes "$@"
if [ "$PUBQUIZ_LAN" = "1" ] || [ -n "$PUBQUIZ_PUBLIC_HOST" ]; then
  echo "PUBQUIZ_LAN and PUBQUIZ_PUBLIC_HOST were removed: the quiz is no longer offered over plain HTTP on the local network. Teams join through the internet link. With no internet at the venue, share your phone's connection with this computer." >&2
  exit 1
fi
[ -n "$PUBQUIZ_HOST_PIN" ] && set -- "$@" --host-pin "$PUBQUIZ_HOST_PIN"
[ -n "$PUBQUIZ_PUBLIC_URL" ] && set -- "$@" --public-url "$PUBQUIZ_PUBLIC_URL"
[ "$PUBQUIZ_OPEN_HOST" = "1" ] && set -- "$@" --open-host
[ "$PUBQUIZ_SHORT_LINKS" = "1" ] && set -- "$@" --short-links
[ -n "$PUBQUIZ_TUNNEL_HOURS" ] && [ "$PUBQUIZ_TUNNEL_HOURS" != "0" ] && set -- "$@" --tunnel-hours "$PUBQUIZ_TUNNEL_HOURS"
# No eval or new Function at runtime: a whole class of injection bugs becomes an error for that request instead of code running.
exec node --disallow-code-generation-from-strings /app/server/main.ts "$@"
