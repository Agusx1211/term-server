FROM node:22-bookworm-slim AS web
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.client.json vite.config.ts ./
COPY src/client ./src/client
COPY src/shared ./src/shared
RUN npm run build:client

FROM rust:1.93-bookworm AS backend
WORKDIR /build
ARG TERM_SERVER_BUILD_COMMIT=unknown
COPY Cargo.toml Cargo.lock ./
COPY build.rs ./
COPY src ./src
COPY release ./release
RUN TERM_SERVER_BUILD_COMMIT="$TERM_SERVER_BUILD_COMMIT" cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates curl tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 term-server \
    && useradd --uid 10001 --gid term-server --create-home --shell /bin/bash term-server \
    && install -d -o term-server -g term-server /data /usr/share/term-server/client
COPY --from=backend /build/target/release/term-server /usr/local/bin/term-server
COPY --from=web /build/dist/client /usr/share/term-server/client

ENV TERM_SERVER_HOST=0.0.0.0 \
    TERM_SERVER_PORT=8090 \
    TERM_SERVER_DATA_DIR=/data \
    TERM_SERVER_CLIENT_DIR=/usr/share/term-server/client
USER term-server
VOLUME ["/data"]
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl --fail --insecure --silent https://127.0.0.1:8090/healthz >/dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/term-server"]
