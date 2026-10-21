#!/usr/bin/env bash
# Opens the release issue on the Friday before a fortnightly release Monday. Run by .github/workflows/release-reminder.yml.
# Releases are every second Monday from RELEASE_ANCHOR. Set FORCE=1 to open one anyway; DRY_RUN=1 to print instead of create;
# TODAY=YYYY-MM-DD to pretend it is another day (for testing).
set -euo pipefail

RELEASE_ANCHOR="${RELEASE_ANCHOR:-2026-11-02}"
TODAY="${TODAY:-$(date -u +%F)}"

today_s=$(date -u -d "$TODAY" +%s)
monday_s=$(( today_s + 3 * 86400 ))            # the Monday after a Friday
monday=$(date -u -d "@$monday_s" +%F)
days=$(( ( monday_s - $(date -u -d "$RELEASE_ANCHOR" +%s) ) / 86400 ))

if [ "$(date -u -d "$TODAY" +%u)" != "5" ] && [ "${FORCE:-0}" != "1" ]; then echo "$TODAY is not a Friday; nothing to do."; exit 0; fi
if { [ "$days" -lt 0 ] || [ $(( days % 14 )) -ne 0 ]; } && [ "${FORCE:-0}" != "1" ]; then echo "The Monday after $TODAY ($monday) is not a release day; nothing to do."; exit 0; fi

version=$(node -p "const [a,b]=require('./package.json').version.split('.'); a+'.'+(Number(b)+1)+'.0'")
title="Release v$version: Monday $monday"
body=$(sed -e "s/{{VERSION}}/$version/g" -e "s/{{DATE}}/$monday/g" .github/release-issue-template.md)

if [ "${DRY_RUN:-0}" = "1" ]; then printf '%s\n\n%s\n' "$title" "$body"; exit 0; fi

if [ -n "$(gh issue list --state all --search "\"$title\" in:title" --json number --jq '.[0].number')" ]; then echo "Already opened: $title"; exit 0; fi
gh issue create --title "$title" --body "$body"
