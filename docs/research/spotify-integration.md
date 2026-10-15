# Spotify integration for the music round: research findings

Research date: 15 October 2026. Research only; no code written, no Spotify API registered or called.

Method and limits: every claim below was read from the page named next to it (fetched through a summarising tool, so quotes are as returned by it and the Developer Policy fetch was short-quote only). Items marked **[UNVERIFIED]** could not be confirmed from an official page. This is not legal advice; for anything that matters, ask Spotify and PPL PRS in writing.

## 1. Summary and recommendation

**Do not build a Spotify integration that plays music or gamifies Spotify content. Build a "bring your own metadata, play your own audio" music round instead.**

Why:

1. **Spotify's Developer Policy bans exactly this product.** Section III.2: "Do not create a game, including trivia quizzes." Section III.10 also bars products "targeted for use by businesses" and says Spotify "can't be broadcast or played publicly from a business" (bars named). A pub quiz is a trivia game played in a bar. Source: <https://developer.spotify.com/policy> (version effective 15 May 2025, read 15 Oct 2026).
2. **Even if it were allowed, it is impractical for an open-source tool.** Since February 2026 every Development Mode app needs its owner on Premium, is capped at 5 users, and extended (production) access needs a legal organisation with 250k+ monthly users. Each host would have to register their own Spotify developer app. Playlist contents can only be read for playlists the user owns or collaborates on.
3. **Licensing is a separate problem from the API.** Spotify consumer terms are personal and non-commercial, and PPL PRS says consumer streaming is "for personal use only" in a business.
4. **What is safe and still valuable:** the app already supports the host's own audio files. Add (a) a metadata-only question generator that accepts a plain list (CSV/pasted text/exported playlist file, optionally enriched from MusicBrainz) and creates music questions (type-the-answer, first letter, multiple choice, order by year), and (b) a "now playing" cue sheet for the host, with the host playing audio however they are licensed to. Do not call Spotify's API at all.

## 2. Q1: What the Web API can still do for a new app

Status today (new app, created after 11 Feb 2026):

| Capability | Status | Source (date) |
|---|---|---|
| Playlist contents (`/playlists/{id}/items`, renamed from `/tracks`) | Only for playlists the user **owns or collaborates on**; other playlists (including followed or Spotify-made) return no items | [Feb 2026 migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide) (Feb 2026; effective 11 Feb for new apps) |
| Batch track lookups (`GET /tracks?ids=`) | Removed; fetch one by ID | same |
| Search | Works, but `limit` max cut from 50 to 10, default 5 | same |
| `GET /artists/{id}/top-tracks`, `/browse/new-releases`, `/browse/categories`, `GET /users/{id}/playlists`, `GET /markets` | Removed | same |
| Track fields removed | `available_markets`, `linked_from`, `popularity` (`external_ids` removed then reverted March 2026) | same |
| Fields still present (per docs structure) | name, artists, album, release_date, duration_ms. The migration page does not list these as removed. | same; **[UNVERIFIED]** I did not read the live track object reference |
| Audio features, audio analysis, recommendations, related artists, featured playlists, Spotify-owned/algorithmic playlists | Not available to apps registered on/after 27 Nov 2024 | [Blog, 27 Nov 2024](https://developer.spotify.com/blog/2024-11-27-changes-to-the-web-api) |
| `preview_url` (30 s clip) | Removed for new apps in the Nov 2024 change (the blog lists "30-second preview URLs in multi-get responses"). Community reports say it is null for new apps in all endpoints. The migration guide does not mention it. Official deprecation wording **[UNVERIFIED]** (community threads claim "officially deprecated" but I could not open the page). Treat as **not available**. | Blog above; [community thread](https://community.spotify.com/t5/Spotify-for-Developers/Preview-URLs-Deprecated/td-p/6791368) (anecdotal) |

Conclusion: you can still read a host-owned playlist and get title/artist/album/year/duration. The spec's "multiple choice with distractors from the same playlist" and "order by year" work from that data. No clips, no audio analysis.

Caveat: March 2026 community staff reply says planned endpoint changes for existing Development Mode apps were postponed with timeline to follow. I found no later dated post resolving this. The endpoint set may shrink again (**[UNVERIFIED]** current state). Source: [update thread](https://community.spotify.com/t5/Spotify-for-Developers/February-2026-Spotify-for-Developers-update-thread/td-p/7330564) and [blog 6 Feb 2026](https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security).

## 3. Q2: Playback options

- **Web API player endpoints** (`PUT /me/player/play`): "This API only works for users who have Spotify Premium." Needs scope `user-modify-playback-state`, accepts `position_ms` and optional `device_id`; controls an already-open Spotify Connect device (the Spotify app on the laptop or a speaker). Source: [reference](https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback) (read 15 Oct 2026). Realistic for a laptop host: the host has the Spotify desktop app open, our page sends "play track X at 45 s". Note "order of execution is not guaranteed" with other player calls, so expect small timing jitter.
- **Web Playback SDK** (makes the host browser tab itself a Connect device): requires Premium; "supported by most web browsers (Chrome, Firefox, Safari and Microsoft Edge)"; browsers may block autoplay so a user click must call `activateElement()`; an `autoplay_failed` event exists; `account_error` fires without Premium; tokens last at most 60 minutes; EME failure is possible "due to the browser not supporting EME protection". Sources: [overview](https://developer.spotify.com/documentation/web-playback-sdk), [reference](https://developer.spotify.com/documentation/web-playback-sdk/reference). Scopes (commonly `streaming` plus user-read scopes) **[UNVERIFIED]**: the page fetch did not list them. Widevine/DRM specifics and "tab must stay foreground" **[UNVERIFIED]** (not stated on the pages I read). Both pages also carry the line "The Spotify Platform can not be used to develop commercial streaming integrations."
- **iOS/Android SDKs**: not relevant to a laptop-hosted web page; not researched.
- For our setup the Web API route with the desktop app is the lighter one, the Web Playback SDK avoids needing a second app but adds DRM and autoplay fragility. Neither is permitted for our use case (section 5).

## 4. Q3: Authorisation for a self-hosted app

- Flow: Authorization Code with PKCE is the one for apps with no secret server (standard; the redirect-URI page below is the relevant one I verified).
- **Redirect URIs**: "Use HTTPS for your redirect URI, unless you are using a loopback address, when HTTP is permitted." Loopback must be IP literal `http://127.0.0.1:PORT` or `http://[::1]:PORT`; "`localhost` is not allowed". A loopback URI may be registered without a port and the port supplied at request time. Enforced for new apps from 9 April 2025; existing clients to migrate by November 2025. Source: <https://developer.spotify.com/documentation/web-api/concepts/redirect_uri> (read 15 Oct 2026). Our server is on a random/changeable port and an https tunnel URL changes per run, so the loopback IP form on the host's own laptop is the only workable one.
- **Each host needs their own client ID.** Shipping one shared client ID would put every user of the tool under that one Development Mode app: max 5 users, owner's Premium required (below). Source: [quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes).
- **Development Mode today**: "All Development Mode apps require the app owner to have an active Spotify Premium subscription" (app stops if it lapses); up to 5 authorised users on an allowlist; Spotify says it supports "non-commercial use by individual developers" and "should not be relied on as a foundation for building or scaling a business". Client IDs per developer went from 1 (Feb 2026) to 25 (July 2026) with a quota shared per developer account. Sources: [migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide), [blog 6 Feb 2026](https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security), [blog 23 Jul 2026](https://developer.spotify.com/blog/2026-07-23-web-api-quota-updates), [changelog July 2026](https://developer.spotify.com/documentation/web-api/references/changes/july-2026).
- **Extended quota mode**: needs a legally registered organisation (individuals not accepted since 15 May 2025), a launched service, "at least 250k monthly active users", key-market availability, commercial viability; review "can take up to six weeks". Sources: [quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes), [blog 15 Apr 2025](https://developer.spotify.com/blog/2025-04-15-updating-the-criteria-for-web-api-extended-access). An open-source hobby tool will not qualify.
- **Avoiding per-host developer apps**: no way found. Shared client ID hits the 5-user cap; extended access is out of reach. Not verified whether PKCE with a shared public client ID is treated differently for the cap; the quota page says allowlist applies to "authenticated users" of the app, so assume it is.

## 5. Q4: Terms and licensing

**Spotify Developer Policy** (effective 15 May 2025; read 15 Oct 2026, <https://developer.spotify.com/policy>). Short quotes as returned:

- III.2: "Do not create a game, including trivia quizzes."
- III.10: "Do not build products or services which are targeted for use by businesses, such as in-store or by retail employees." Spotify is for personal, non-commercial use and "can't be broadcast or played publicly from a business" (radio stations, bars, restaurants and stores named).
- III.14: no use of the Platform or Spotify Content to train or feed ML/AI models. III.5: no products integrated with another service's streams or content. III.7: no mixing Spotify Content with other audio. III.13: no analysing Spotify Content or the Service for metrics or user profiling.
- IV.1: streaming of music recordings only to Premium subscribers. IV.2: commercial use generally not permitted for SDAs (apps), including selling a streaming app or advertising/sponsorship on it.
- II.5: no playback without showing cover art and metadata, which also clashes with "hide the title on the TV".

Reading: a quiz app that uses Spotify to drive a music round is a "game, including trivia quizzes", played in a venue ("bars" named). Metadata-only use still uses the Platform and Spotify Content, so III.2 applies to it too. It remains possible Spotify would tolerate a private, personal setup, but that is not what the policy says and I would not build features on that hope. I only have the short policy quotes; I did not read the separate Developer Terms (definitions of Streaming SDA, etc.) **[UNVERIFIED]**.

**Web Playback SDK and Player API pages** both state: "The Spotify Platform can not be used to develop commercial streaming integrations."

**Spotify Terms of Use** (UK, last updated 26 Aug 2025, <https://www.spotify.com/uk/legal/end-user-agreement/>): grants "limited, non-exclusive, revocable permission to make personal, non-commercial use of the Spotify Service"; "You agree that you will not redistribute, sell or transfer the Spotify Service or the Content." No clause on public performance by users, and no business licence. The Developer Policy III.10 is the clause that speaks to bars.

**UK pub music licensing** (PPL PRS, <https://pplprs.co.uk/background-music/streaming/>, footer 2026, no publication date): consumer platforms such as Spotify and YouTube are "for personal use only"; businesses should use a commercial streaming service from a provider licensed by PPL and PRS; TheMusicLicence is needed to play music in public "including streamed music", and still needed with a commercial streaming service. So: a pub normally needs TheMusicLicence, and a consumer Spotify subscription does not satisfy the streaming-service side. Third-party legal commentary agrees ([Reed Smith](https://www.reedsmith.com/articles/licensing-of-music-in-the-uk-hospitality-industry/)); I did not read the full article. Whether a pub holds a TheMusicLicence is the venue's matter and the app should not tell hosts it is covered.

## 6. Q5: Features, if they were allowed (they are not, for Spotify)

| Feature | Feasible technically? | Under today's Spotify rules | Effort | Risks |
|---|---|---|---|---|
| (a) Import playlist, auto-generate questions (typed answer, first letter, MC with same-playlist distractors, order by year) | Yes, for host-owned playlists; 5-user cap, each host needs own app | **Blocked** (III.2 game, III.10 business) | M-L (OAuth loopback, token storage, rate limits) | Policy, API churn, Premium needed by owner |
| (b) Start the right track at the right time, with start position | Yes via Player API + `position_ms` | **Blocked** (III.10 public play; also commercial-streaming wording) | M | Needs Premium and an active device; jitter; account ban risk |
| (c) Hide title on TV | Trivial in our own UI | Conflicts with II.5 (show cover art and metadata on playback) | S | Same policy exposure |
| (d) Other | e.g. host cue sheet, round timing | Metadata cue sheet from any source is safe | S | none |

The same features (a), (c) and the cue sheet (d) are fully feasible without Spotify using other sources, see below.

## 7. Q6: Alternatives (terms checked the same way)

- **Host's own audio files (already supported):** clearest position. Licensing is the venue's (TheMusicLicence for public play of legally obtained files; PPL PRS also lists providers for commercial streaming). No API terms.
- **Deezer API:** guidelines page says "Full data access, but no audio streaming available except 30s extracts", "Local Storage/Offline Storage of audio data is strictly forbidden", and apps can be blocked "at any time if it does not fully respect the Terms of use" (<https://developers.deezer.com/guidelines>, undated). The separate Terms of Use page returned 404, so commercial use and games permission is **[UNVERIFIED]**. A game use of previews would likely need written confirmation from Deezer. Status of new API app registration in 2026 **[UNVERIFIED]**.
- **iTunes Search API / `previewUrl`:** Apple's page says previews may be used "only to promote store content, not for entertainment", must sit beside a "Download on iTunes" or App Store badge, attributed "provided courtesy of iTunes", "Stream song and music video previews only. Do not download, save, cache"; rate limit about 20 calls/minute (<https://performance-partners.apple.com/search-api>, undated). Using previews as quiz audio is entertainment, so **not allowed** by that wording.
- **MusicBrainz (metadata only):** core data is CC0 and supplementary data CC BY-NC-SA 3.0; API limit about 1 request/second per IP and a proper User-Agent is required (<https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting>, search summary only; <https://musicbrainz.org/doc/About/Data_License> via search results at a mirror, **partly UNVERIFIED**). No audio. Good for release year, canonical artist/title spelling, accepted variants. Cover Art Archive not researched. Note CC BY-NC-SA for non-core data would matter for a commercial tool.
- **Hybrid (recommended):** the host supplies a track list (typed, CSV or the user's own export from whatever service); the app generates the questions and a host cue sheet (which track next, answer, year); the host plays audio from their own files or licensed system. Optional MusicBrainz enrichment for year and alternate names. This touches no third-party audio and no Spotify terms.

## 8. Proposed phased plan

1. **Phase 1 (S, about 1-2 days):** "Music list import": paste or upload CSV/text (title, artist, optional year, optional audio filename) and generate `music`/`letter`/`multiple-choice`/`ordering` questions into the existing editor; distractors from the same list; auto-attach audio files by filename if the host has them next to the quiz. Reuses the existing audio field.
2. **Phase 2 (S-M, 2-3 days):** Host cue sheet panel: next track, start offset, "audio cue" button for local files; hide title on TV is already the default as the TV is answer-blind before reveal (confirm).
3. **Phase 3 (M, optional, 2-4 days):** MusicBrainz lookups to fill year and aliases into `accept`, with caching, 1 request/s throttle and attribution.
4. **Phase 0 (do first, S):** ask Spotify (developer support) whether an unmonetised open-source tool that merely reads the user's own playlist metadata for a pub quiz is acceptable. Do not build Spotify features before a written yes.
5. **Not planned:** Spotify playback, Web Playback SDK, preview-URL features from Deezer/Apple.

## 9. Open questions for the owner

1. Is this tool used only at your own pub or distributed to other hosts? (Distribution makes commercial/organisation questions heavier.)
2. Is the venue covered by TheMusicLicence, and does it play via a commercial streaming service? The app should not claim anything on this.
3. Would you accept the list-import approach (no Spotify at all), or is Spotify-driven playback itself the goal?
4. Are you willing to email Spotify developer support for a written position (Phase 0)?
5. Do hosts have music files already, or would playing "from Spotify on a phone through the speakers" remain their manual practice (not covered by our app either way)?
6. Items I could not verify and that a decision might hinge on: current official wording on `preview_url`; Web Playback SDK scopes and Widevine/foreground behaviour; the Developer Terms definitions; Deezer Terms of Use; Apple Media Services terms; whether endpoint cuts postponed in March 2026 have a new date.

## 10. Source list (all read 15 Oct 2026)

- Developer Policy (eff. 15 May 2025): <https://developer.spotify.com/policy>
- Blog 27 Nov 2024: <https://developer.spotify.com/blog/2024-11-27-changes-to-the-web-api>
- Blog 15 Apr 2025 (extended access, eff. 15 May 2025): <https://developer.spotify.com/blog/2025-04-15-updating-the-criteria-for-web-api-extended-access>
- Blog 6 Feb 2026: <https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security>
- Migration guide (Feb 2026): <https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide>
- Blog 23 Jul 2026 and changelog: <https://developer.spotify.com/blog/2026-07-23-web-api-quota-updates>, <https://developer.spotify.com/documentation/web-api/references/changes/july-2026>
- Quota modes: <https://developer.spotify.com/documentation/web-api/concepts/quota-modes>
- Redirect URIs: <https://developer.spotify.com/documentation/web-api/concepts/redirect_uri>
- Player API: <https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback>
- Web Playback SDK: <https://developer.spotify.com/documentation/web-playback-sdk>, <https://developer.spotify.com/documentation/web-playback-sdk/reference>
- Spotify Terms of Use (UK, 26 Aug 2025): <https://www.spotify.com/uk/legal/end-user-agreement/>
- PPL PRS streaming FAQ: <https://pplprs.co.uk/background-music/streaming/>
- Deezer guidelines: <https://developers.deezer.com/guidelines>
- Apple Search API: <https://performance-partners.apple.com/search-api>
- MusicBrainz: <https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting>
