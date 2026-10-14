#!/bin/sh
# Turns the PUBQUIZ_* environment variables into command-line options.
set -e
set -- --no-open --port 3000 --quizzes /data/quizzes "$@"
[ -n "$PUBQUIZ_HOST_PIN" ] && set -- "$@" --host-pin "$PUBQUIZ_HOST_PIN"
[ -n "$PUBQUIZ_PUBLIC_HOST" ] && set -- "$@" --public-host "$PUBQUIZ_PUBLIC_HOST"
[ -n "$PUBQUIZ_PUBLIC_URL" ] && set -- "$@" --public-url "$PUBQUIZ_PUBLIC_URL"
[ "$PUBQUIZ_LAN" = "1" ] && set -- "$@" --lan
exec node /app/server/main.ts "$@"
