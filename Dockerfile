FROM node:22-slim

WORKDIR /app

COPY package.json bun.lock ./

RUN npm install -g bun@1.2.4 \
    && bun install --frozen-lockfile

COPY . .

RUN bun run build

CMD ["node", "dist/main.js"]
