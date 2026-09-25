FROM node:22-slim AS builder

WORKDIR /app

COPY package.json bun.lock ./

RUN npm install -g bun@1.2.4 \
    && bun install --frozen-lockfile

COPY . .

RUN bun run build


FROM node:22-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && curl -fsSL \
      https://github.com/openai/tunnel-client/releases/download/v0.0.15/tunnel-client-v0.0.15-linux-amd64.zip \
      -o /tmp/tunnel-client.zip \
    && unzip /tmp/tunnel-client.zip -d /tmp/tunnel-client \
    && find /tmp/tunnel-client -type f -name 'tunnel-client' -exec cp {} /usr/local/bin/tunnel-client \; \
    && chmod +x /usr/local/bin/tunnel-client \
    && rm -rf /tmp/tunnel-client /tmp/tunnel-client.zip \
    && apt-get purge -y curl unzip \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app /app

ENV MCP_COMMAND="node /app/dist/main.js"
ENV LOG_LEVEL="info"
ENV LOG_FORMAT="json"
ENV HEALTH_LISTEN_ADDR=":8080"

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/tunnel-client"]
CMD ["run"]
