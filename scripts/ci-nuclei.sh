#!/usr/bin/env bash
# Runs nuclei's misconfiguration and exposure templates against the app started by ci-start-app.sh, signed in as
# the host (the key goes on every request as the x-host-key header, as for ZAP). Nightly, beside the ZAP full scan.
# Exit status: fails the build on a finding of medium severity or above; lower ones are only reported.
set -uo pipefail

OUT="${RUNNER_TEMP:-/tmp}/nuclei"
mkdir -p "$OUT"
chmod 777 "$OUT"
rm -f "$OUT/findings.jsonl"

KEY="${PUBQUIZ_HOST_KEY:?PUBQUIZ_HOST_KEY is not set}"
TARGET="${TARGET:-http://localhost:3000}"
# A scan of nothing would pass with no findings; make sure the app is actually there.
curl -fsS "$TARGET/healthz" >/dev/null || { echo "The app is not answering at $TARGET" >&2; exit 1; }

# The image ships without templates; the first run fetches the current community set (so the nightly always uses the latest).
# -ni: no out-of-band (interactsh) callbacks; the app has no business calling out, and the runner should not either.
docker run --rm --network host -v "$OUT:/out" "${NUCLEI_IMAGE:-projectdiscovery/nuclei:v3.11.1}" \
  -u "$TARGET" -H "x-host-key: $KEY" \
  -tags misconfig,exposure -exclude-tags fuzz,dos,intrusive \
  -ni -nc -rate-limit 50 -timeout 10 -retries 1 \
  -jsonl -o /out/findings.jsonl -stats -silent
CODE=$?
echo "nuclei exit code: $CODE"
[ "$CODE" -eq 0 ] || exit 1

touch "$OUT/findings.jsonl"
TOTAL=$(wc -l < "$OUT/findings.jsonl" | tr -d ' ')
SERIOUS=$(jq -c 'select(.info.severity | test("^(medium|high|critical)$"))' "$OUT/findings.jsonl" | wc -l | tr -d ' ')

{
  echo "## nuclei: $TOTAL finding(s), $SERIOUS of medium severity or above"
  if [ "$TOTAL" -gt 0 ]; then
    echo
    echo '| Severity | Template | Where |'
    echo '|---|---|---|'
    jq -r '"| \(.info.severity) | \(."template-id") | \(.["matched-at"] // .host) |"' "$OUT/findings.jsonl"
  fi
} | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"

[ "$SERIOUS" -eq 0 ] || { echo "nuclei found $SERIOUS finding(s) of medium severity or above" >&2; exit 1; }
