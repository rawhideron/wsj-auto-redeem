FROM node:24-slim

# Real Google Chrome + Xvfb (headful mode is harder to fingerprint than headless Chromium)
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget gnupg ca-certificates fonts-liberation \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcups2 \
    libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 \
    libwayland-client0 libxcomposite1 libxdamage1 libxfixes3 \
    libxkbcommon0 libxrandr2 xdg-utils xvfb xauth dbus-x11 cron \
 && wget -q -O- https://dl.google.com/linux/linux_signing_key.pub \
        | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
        > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
 && rm -rf /var/lib/apt/lists/*

ENV CHROME_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

WORKDIR /app

COPY package.json ./
RUN npm install

COPY redeem.js ./
COPY crontab /etc/cron.d/wsj-cron

RUN chmod 0644 /etc/cron.d/wsj-cron \
 && crontab /etc/cron.d/wsj-cron \
 && touch /var/log/cron.log \
 && mkdir -p /app/cookies

# Dump container env to a file that cron can source before running redeem.js
CMD printenv | grep -E '^(WSJ_|LIBRARY_|COOKIE_|CHROME_|USER_DATA_|FAIRVIEW_|TZ)' \
        | sed 's/^\(.*\)$/export \1/' > /app/.env-cron \
 && cron \
 && tail -f /var/log/cron.log
