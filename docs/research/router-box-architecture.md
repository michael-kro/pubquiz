# Quiz box: GL.iNet router architecture

Oct 14, 2026 · @Michael M Harms

## Overview

One GL.iNet travel router is the whole product: it makes the quiz Wi-Fi, runs the quiz server, and shares the venue's internet when one is plugged in. Players join from a phone browser with no app, the host runs the night from their own phone, and an optional TV shows questions and scores.

Design goals:

- **Zero install** for players and host: everything is a web page served by the router.
- **Works offline**: the quiz never depends on the internet; internet is a bonus shared to players.
- **Fair speed scoring**: all timing happens on the router, over a local network with tiny, even delays.
- **Free and self-hosted**: no cloud account, no subscription; hosts write their own questions.
- **Survives a pub**: phones dropping, rejoining and sleeping mid-round must never lose a score.

## Hardware

The Beryl AX is the recommended target: enough memory and storage for the server, Wi-Fi 6 for crowded rooms, and USB for media. Specs and prices below are approximate, from memory; check current listings before buying.

| Model | CPU | RAM / flash | USB | Approx. price | Fit |
| --- | --- | --- | --- | --- | --- |
| Beryl AX (GL-MT3000) | 4-core ARM, 1.3 GHz | 512 MB / 256 MB | 3.0 | £80–£90 | Recommended |
| Slate AX (GL-AXT1800) | 4-core ARM, 1.2 GHz | 512 MB / 128 MB | 3.0 | £100–£120 | Good; less flash |
| Mango / Opal class | Single or low-end | 128 MB or less | None or 2.0 | £25–£40 | Too small |

Also needed:

- A USB stick (16–32 GB) for quiz files, images and audio.
- A USB-C power bank for venues with no spare socket; the Beryl AX draws a few watts.
- Optional: an Ethernet cable for the venue uplink, the most reliable internet source.

## Network design

The router runs in normal router mode: a quiz Wi-Fi on the inside, an optional uplink on the outside, and NAT between them, so players get internet whenever the box has it.

**Quiz Wi-Fi (LAN side)**

- One SSID, e.g. `QuizNight`, WPA2 with a simple password shown on the TV, or open if the host prefers.
- Router address `192.168.8.1` (GL.iNet default); DHCP pool sized for 100+ leases.
- Turn client isolation **off** on this SSID so phones can reach the quiz server.
- Prefer 5 GHz for players; keep 2.4 GHz on for older phones.

**Uplink (WAN side), in order of preference**

1. Ethernet from the venue router: plug and go.
2. Repeater mode: the box joins the venue Wi-Fi as a client. Venue login pages make this fiddly.
3. Phone tethering over USB: the host's phone shares 4G with the box.
4. None: the quiz still runs; players just have no internet on this Wi-Fi.

**Name resolution**

- dnsmasq maps `quiz.lan` (and a short alias such as `q.lan`) to `192.168.8.1`; everything else resolves upstream as normal. Avoid `.local`, which phones send to mDNS instead of DNS.
- The TV shows two QR codes: one to join the Wi-Fi (`WIFI:S:QuizNight;T:WPA;P:…;;`), one for `http://quiz.lan`.
- With no uplink, answer the phones' connectivity checks with a captive portal so the join page pops up automatically. With an uplink, leave the checks alone so phones stay happy.

**Ports and firewall**

- The quiz server listens on port 80 on the LAN only; the router's admin UI moves to another port or is password-locked.
- Nothing is exposed on the WAN side.
- Optional host toggle: a firewall rule that blocks LAN-to-WAN traffic during questions, for hosts who want to stop searching (players on 4G can still do it).

## Software components

One Go program on the router does everything quiz-related; the router's own OpenWrt services handle Wi-Fi, names and internet sharing.

&#91;embedded content: quiz box components · 3 clients, 1 router\]

Every screen is a page served by the router and talks to the game engine over one WebSocket; the engine is the only thing that keeps state.

| Component | Built with | Job |
| --- | --- | --- |
| Game engine | Go | State machine, timers, scoring, rejoin tokens |
| Web server | Go `net/http` + a WebSocket library (e.g. `coder/websocket`) | Serves pages, media and `/ws` |
| Player page | Plain HTML/JS or Svelte, built into the binary | Join, answer, see result |
| Host remote | Same bundle, `/host`, PIN-protected | Run the night, edit quizzes |
| TV screen | Same bundle, `/screen` | Questions, timer, leaderboard, join QR codes |

Keep the front end small (under about 200 KB) so 50 phones loading it at once barely touch the Wi-Fi.

## Game flow and real-time protocol

The server owns one state machine per quiz; every client just renders the state it is sent.

1. **Lobby**: host loads a quiz; players join with a team name and get a session token.
2. **Question**: server sends the question with a deadline; answers are accepted until it passes or everyone has answered.
3. **Reveal**: correct answer and per-team points shown.
4. **Leaderboard**: after each question or each round, host's choice.
5. Repeat 2–4, then **Final** with the winner.

The host can pause, skip, extend the timer, re-mark a question or kick a team at any point.

All clients use one WebSocket at `/ws`, with JSON messages:

| Message | Direction | Purpose |
| --- | --- | --- |
| `join` | player → server | Team name, or a saved token to rejoin |
| `state` | server → all | Current phase, question, timer, scores (full snapshot) |
| `answer` | player → server | Chosen option or typed text, plus question id |
| `ack` | server → player | Answer received, locked in |
| `host` | host → server | Start, next, pause, extend, re-mark, kick (PIN-authenticated) |
| `ping` / `pong` | both ways | Latency measure and keep-alive every 5 s |

Sending a full `state` snapshot on every change, rather than diffs, makes reconnects trivial: a phone that wakes up gets one message and is current.

## Scoring and fair timing

A correct answer scores between full and half points, falling linearly with time taken; wrong or missing answers score zero.

```latex
\text{points} = P_{\max} \left(1 - \frac{t}{2T}\right), \quad 0 \le t \le T
```

Here P max is the question's value (default 1000), t the answer time and T the time limit. Hosts can switch a round to flat scoring, or to bonus points for the first correct team only.

Measuring t fairly:

- Each phone measures its own t: from the moment the question appears on its screen to the tap, using the browser's monotonic clock (`performance.now()`), so delivery delay never counts against it.
- The server also knows its own bound: time since it sent the question, minus that phone's measured round-trip from `ping`.
- The server accepts the phone's t only if it falls inside that bound (plus a small tolerance); otherwise it uses its own figure. This stops a tampered page from claiming instant answers.
- On a local network round-trips are a few milliseconds, so the bound is tight and the result is fair.

Ties on points are broken by the summed answer times across the quiz, then by a tie-break question the host controls.

## Storage and data model

Quizzes are plain files on the USB stick; live game state stays in memory, with a snapshot written after every question so a power cut loses at most one question.

On the USB stick:

```
/quizbox/
  quizzes/
    friday-league-wk12/
      quiz.json
      media/round3-q4.jpg
  games/
    2026-10-17-friday-league-wk12.json   # results + snapshot
  config.json                             # host PIN, Wi-Fi name, defaults
```

A `quiz.json` holds rounds, each with questions:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Stable id, used in answers |
| `type` | `choice` / `text` / `number` | Typed answers are matched case- and accent-insensitively, with host-listed alternatives |
| `prompt` | string | The question |
| `options` | string\[\] | For `choice` only |
| `answer` | string or string\[\] | Accepted answer(s) |
| `media` | path | Optional image or audio clip in `media/` |
| `timeLimit` | seconds | Defaults per round |
| `points` | number | Defaults to 1000 |

Why files, not a database: hosts can copy, share and back up quizzes by moving a folder, write them by hand or in a spreadsheet export, and nothing needs migrating. Writes go through a temp file and rename, so a pulled stick never leaves a half-written quiz.

Media: images are resized on upload to about 1280 px wide to keep the load on 50 phones light. Audio is better played from the TV than streamed to every phone.

## Deployment on OpenWrt

The whole server ships as one Go binary with the web pages embedded, plus a start-up script and a small network config: one package, installed once.

Build:

```
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -ldflags="-s -w" -o quizbox ./cmd/quizbox
```

Both recommended routers are 64-bit ARM. With no C dependencies the binary is static and about 8–12 MB; it can live on the USB stick if internal flash is tight.

On the router:

- **Service**: a procd init script (`/etc/init.d/quizbox`) starts the binary at boot and restarts it if it crashes.
- **First-boot setup**: a `uci-defaults` script adds the `quiz.lan` DNS entry, sets the SSID, turns off client isolation and moves the admin UI off port 80.
- **Package**: wrap binary, init script and setup script into an OpenWrt package so a host installs it from the router's admin page in one upload.
- **Updates**: upload a new package, or drop a new binary on the USB stick; the service picks it up on restart.

Development loop: run the same binary on a laptop (`go run`) against phones on home Wi-Fi; only cross-compile to test on the router. Nothing in the code is router-specific except the optional firewall toggle, which calls `uci` and `fw4`.

## Limits, risks and build plan

The main limit is Wi-Fi, not the server: plan for 30–60 phones per box, and test with real phones in a real room before promising more.

| Risk | Effect | Mitigation |
| --- | --- | --- |
| Too many phones for one radio | Lag, dropped answers | Cap teams (one phone per team), 5 GHz, test at venue size |
| Phones leave the quiz Wi-Fi for 4G | Players vanish mid-round | Share internet when possible; rejoin by token; clear on-screen tip |
| Venue Wi-Fi needs a login page | No uplink in repeater mode | Use Ethernet or phone tethering; quiz runs offline anyway |
| Power cut or pulled cable | Game interrupted | Snapshot after each question; power bank |
| Uploaded media is large | Slow question load | Resize on upload; play audio from the TV |
| Tampered player page | Fake fast answers | Server-checked timing bound |

Build plan, one developer, part-time:

1. **Weeks 1–2**: Go server, state machine, WebSocket protocol; run on a laptop.
2. **Weeks 3–4**: player, host-remote and TV pages; speed scoring; rejoin.
3. **Week 5**: quiz editor on the host page, media upload, files on USB.
4. **Week 6**: cross-compile, init script, network setup on the Beryl AX.
5. **Weeks 7–8**: load test with 30+ phones, a trial night, fix what breaks.
