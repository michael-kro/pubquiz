#!/bin/sh
# Turns the PUBQUIZ_* environment variables into command-line options.
set -e
set -- --no-open --port 3000 --quizzes /data/quizzes "$@"
[ -n "$PUBQUIZ_HOST_PIN" ] && set -- "$@" --host-pin "$PUBQUIZ_HOST_PIN"
[ -n "$PUBQUIZ_PUBLIC_HOST" ] && set -- "$@" --public-host "$PUBQUIZ_PUBLIC_HOST"
[ -n "$PUBQUIZ_PUBLIC_URL" ] && set -- "$@" --public-url "$PUBQUIZ_PUBLIC_URL"
[ "$PUBQUIZ_OPEN_HOST" = "1" ] && set -- "$@" --open-host
[ "$PUBQUIZ_SHORT_LINKS" = "1" ] && set -- "$@" --short-links
[ "$PUBQUIZ_LAN" = "1" ] && set -- "$@" --lan
# No eval or new Function at runtime: a whole class of injection bugs becomes an error for that request instead of code running.
exec node --disallow-code-generation-from-strings /app/server/main.ts "$@"
