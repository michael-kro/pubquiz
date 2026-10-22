#!/usr/bin/env bash
# Builds the Docker image and starts it on a throwaway library with a random host key, for the DAST jobs.
# Leaves PUBQUIZ_HOST_KEY in $GITHUB_ENV (masked) so the scan can sign in as the host.
set -euo pipefail

TMP="${RUNNER_TEMP:-$(mktemp -d)}"
LIB="$TMP/lib"
mkdir -p "$LIB/sample"
cp examples/sample-quiz.yaml "$LIB/sample/quiz.yaml"
cp -R examples/images "$LIB/sample/images"

KEY="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | cut -c1-24)"
echo "::add-mask::$KEY"
printf '%s' "$KEY" > "$LIB/.host-key"
chmod 600 "$LIB/.host-key"
[ -n "${GITHUB_ENV:-}" ] && echo "PUBQUIZ_HOST_KEY=$KEY" >> "$GITHUB_ENV"

docker build --pull -t pubquiz:ci .
docker rm -f pubquiz >/dev/null 2>&1 || true
# No internet link (nothing for the scanner to reach but the app), and files owned by the runner so the app can write.
docker run -d --name pubquiz --user "$(id -u):$(id -g)" -p 127.0.0.1:3000:3000 -e PUBQUIZ_PUBLIC_URL=http://localhost:3000 -v "$LIB:/data/quizzes" pubquiz:ci

for _ in $(seq 1 30); do
  if curl -fsS http://localhost:3000/healthz >/dev/null 2>&1; then echo "App is up"; exit 0; fi
  sleep 2
done
echo "The app did not start" >&2
docker logs pubquiz >&2 || true
exit 1
