#!/bin/sh
# Downloads the film-quote clips listed in clips/manifest.json into clips/audio (kept out of git: the studios own the audio).
cd "$(dirname "$0")/.." || exit 1
mkdir -p clips/audio
node -e 'for (const c of require("./clips/manifest.json").clips) console.log(c.path + " " + c.file)' | while read -r path file; do
  [ -s "clips/audio/$file" ] || { curl -fsS -A "Mozilla/5.0" -o "clips/audio/$file" "https://www.moviesoundclips.net$path"; sleep 0.5; }
done
