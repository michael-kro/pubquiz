#!/usr/bin/env bash
# Runs a ZAP scan against the app started by ci-start-app.sh, signed in as the host. Usage: ci-zap.sh baseline|full
# Exit status: fails the build on a FAIL-level finding (see .zap/rules.tsv); other findings are only reported.
set -uo pipefail

MODE="${1:-baseline}"
OUT="${RUNNER_TEMP:-/tmp}/zap"
mkdir -p "$OUT"
chmod 777 "$OUT"
cp .zap/rules.tsv "$OUT/rules.tsv"

KEY="${PUBQUIZ_HOST_KEY:?PUBQUIZ_HOST_KEY is not set}"
# Every request carries the host key as a header, so the scan can reach /api and not just the public pages.
AUTH="-config replacer.full_list(0).description=hostkey -config replacer.full_list(0).enabled=true -config replacer.full_list(0).matchtype=REQ_HEADER -config replacer.full_list(0).matchstr=x-host-key -config replacer.full_list(0).regex=false -config replacer.full_list(0).replacement=$KEY"

if [ "$MODE" = "full" ]; then SCRIPT=zap-full-scan.py; EXTRA=(-T 25); else SCRIPT=zap-baseline.py; EXTRA=(-m 3); fi

docker run --rm --network host -v "$OUT:/zap/wrk:rw" "${ZAP_IMAGE:-ghcr.io/zaproxy/zaproxy:stable}" \
  "$SCRIPT" -t "http://localhost:3000/host?key=$KEY" -j -c rules.tsv -r report.html -J report.json -w report.md "${EXTRA[@]}" -z "$AUTH"
CODE=$?

# ZAP: 0 clean, 1 a FAIL-level finding, 2 warnings only, 3 the scan itself had a problem.
echo "ZAP exit code: $CODE"
case "$CODE" in
  0|2) exit 0 ;;
  *) exit 1 ;;
esac
