#!/usr/bin/env node
// Stands in for cloudflared in tests: prints log lines like the real thing, then keeps running.
// FAKE_TUNNEL_EXIT_AFTER_MS makes it exit later, as if the tunnel died.
const log = (line) => process.stderr.write(`${new Date().toISOString()} INF ${line}\n`);
log('Requesting new quick Tunnel on trycloudflare.com...');
log('Fetching from https://api.trycloudflare.com/tunnel');
setTimeout(() => {
  log('+--------------------------------------------------------------------------------------------+');
  log('|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |');
  log('|  https://pretty-random-words-here.trycloudflare.com                                        |');
  log('Registered tunnel connection connIndex=0');
}, 50);
const exitAfter = Number(process.env.FAKE_TUNNEL_EXIT_AFTER_MS);
if (exitAfter) setTimeout(() => process.exit(3), exitAfter);
setInterval(() => {}, 1000);
