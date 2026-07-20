# Официальный образ Microsoft уже содержит Chromium/Firefox/WebKit
# и все системные библиотеки для headless-запуска — не нужен apt-get вручную.
FROM mcr.microsoft.com/playwright:v1.47.0-jammy

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
