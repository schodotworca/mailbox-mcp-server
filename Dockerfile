FROM node:22-slim

WORKDIR /app

COPY package.json bun.lock ./

RUN npm install -g bun@1.2.4 \
    && bun install --frozen-lockfile

COPY . .

RUN bun run build

COPY --from=flyio/flyctl /flyctl /usr/bin

ENTRYPOINT ["/usr/bin/flyctl", "mcp", "wrap", "--"]

EXPOSE 8080

CMD ["node", "dist/main.js"]
