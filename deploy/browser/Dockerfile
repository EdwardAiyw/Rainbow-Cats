FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /tests
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY browser-smoke.js ./

CMD ["node", "browser-smoke.js"]
