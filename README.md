# who_liked

A local party game: archive TikTok reposts on your server, then guess who reposted each video.

## Run it

```sh
npm install
npm start
```

Open [http://localhost:3004](http://localhost:3004). On its first run, CloakBrowser downloads its Chromium binary (about 200 MB) into its local cache. Use **Manage repost library** to load accounts. Their reposts are stored in `data/repost-library.json` on the server. The first import scans the full Reposts tab; later updates stop when they reach a repost already saved.

## Run with Docker

Docker Compose builds the app and its Chromium dependencies, starts it on port 3004, and restarts it after host or container restarts. The account archive remains in the host's `./data` directory, so the existing `data/repost-library.json` is used when deploying this checkout.

```sh
docker compose up -d --build
docker compose ps
```

By default, Compose publishes the app only on `127.0.0.1:3004`. Point a reverse proxy running on the same host at `http://127.0.0.1:3004`; terminate HTTPS at the proxy and forward the original `Host` and `X-Forwarded-Proto` headers. Use a dedicated hostname routed to `/` because the app uses root-relative URLs and is not mounted under a URL prefix. To choose a different host port or bind address, set `WHO_LIKED_PORT` or `WHO_LIKED_BIND` in the Compose environment. Set the bind address to `0.0.0.0` only when another machine must reach the app directly.

For a reverse proxy running in Docker, create or use its shared Docker network, then start the app with the proxy network overlay:

```sh
PROXY_NETWORK=reverse-proxy docker compose -f compose.yaml -f compose.proxy.yaml up -d --build
```

The proxy network must already exist. Configure its upstream as `http://who-liked:3004`. The service also keeps the loopback host port available for local health checks. Docker's health check uses `/api/health`; the same endpoint reports archive storage status. The Dockerfile downloads CloakBrowser's Chromium during the image build, so the first sync does not need to download it at runtime.

The container runs as UID 1000 and writes to the bind-mounted `./data` directory. Make sure that directory is writable by UID 1000 on the deployment host.

The library page shows the current account, page count, videos found and saved, elapsed time, and any TikTok errors. It can update selected accounts or all accounts. Partial imports are saved with their next-page cursor after each page, so a retry can continue there. Older partial imports without a saved cursor are deduplicated while the scan advances through their previously saved history. The main game reads only the local library and never waits for a TikTok scan.

You can inspect the server at `/api/health`, saved account counts at `/api/accounts`, and live scan details at `/api/sync/status`.

## How it gets reposts

TikTok does not offer a normal public API for arbitrary users' repost lists. This app follows the open-source [Repostify](https://github.com/xtofuub/Repostify) approach: open each profile in a Chromium browser, select its Reposts tab, and capture TikTok's own repost-list request. The browser runs on the machine hosting this app.

This is unofficial and depends on TikTok's current website. TikTok may hide the Reposts tab, return no results, change its page/API, or present a verification challenge. Private accounts and reposts unavailable to a logged-out visitor cannot be loaded. No TikTok credentials are collected or stored.

Every round first selects a player at random, giving each player equal odds, then selects one of that player's reposts at random. If that video appears in multiple players' lists, any of those players is accepted as correct and the reveal lists all of them.

Repostify is licensed under MIT. This project implements the same general browser-based flow; it does not use or host a Repostify API.
