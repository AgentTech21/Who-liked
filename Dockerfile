FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3004 \
    CLOAKBROWSER_CACHE_DIR=/opt/cloakbrowser

WORKDIR /app

COPY package.json package-lock.json ./

# Install Chromium's Linux libraries and prefetch CloakBrowser's browser so
# the first account sync does not need to download it after the container starts.
RUN npm ci --omit=dev \
    && npx playwright install-deps chromium \
    && npx cloakbrowser install \
    && mkdir -p /app/data \
    && chown -R node:node /app /opt/cloakbrowser \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node server.js ./server.js
COPY --chown=node:node public ./public

USER node

EXPOSE 3004

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3004/api/health').then(response => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
