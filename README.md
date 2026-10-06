# who_liked

A local party game: archive TikTok reposts on your server, then guess who reposted each video.

## Run it

```sh
npm install
npm start
```

Open [http://localhost:3004](http://localhost:3004). On its first run, CloakBrowser downloads its Chromium binary (about 200 MB) into its local cache. Use **Manage repost library** to load accounts. Their reposts are stored in `data/repost-library.json` on the server. The first import scans the full Reposts tab; later updates stop when they reach a repost already saved.

The library page shows the current account, page count, videos found and saved, elapsed time, and any TikTok errors. It can update selected accounts or all accounts. Partial imports are saved with their next-page cursor after each page, so a retry can continue there. Older partial imports without a saved cursor are deduplicated while the scan advances through their previously saved history. The main game reads only the local library and never waits for a TikTok scan.

You can inspect the server at `/api/health`, saved account counts at `/api/accounts`, and live scan details at `/api/sync/status`.

## How it gets reposts

TikTok does not offer a normal public API for arbitrary users' repost lists. This app follows the open-source [Repostify](https://github.com/xtofuub/Repostify) approach: open each profile in a Chromium browser, select its Reposts tab, and capture TikTok's own repost-list request. The browser runs on the machine hosting this app.

This is unofficial and depends on TikTok's current website. TikTok may hide the Reposts tab, return no results, change its page/API, or present a verification challenge. Private accounts and reposts unavailable to a logged-out visitor cannot be loaded. No TikTok credentials are collected or stored.

Every round first selects a player at random, giving each player equal odds, then selects one of that player's reposts at random. If that video appears in multiple players' lists, any of those players is accepted as correct and the reveal lists all of them.

Repostify is licensed under MIT. This project implements the same general browser-based flow; it does not use or host a Repostify API.
