# syntax=docker/dockerfile:1
# Initiative API – Rust. Zwei Stufen, damit das Ergebnis nur die Binary enthält.

FROM rust:1-slim-bookworm AS builder
WORKDIR /build

# Abhängigkeiten zuerst bauen, damit Docker sie zwischen Builds cachen kann.
COPY apps/api/Cargo.toml apps/api/Cargo.lock ./
RUN mkdir -p src/bin \
 && echo 'fn main() {}' > src/main.rs \
 && echo '' > src/lib.rs \
 && echo 'fn main() {}' > src/bin/seed.rs \
 && cargo build --release --locked \
 && rm -rf src

COPY apps/api/src ./src
COPY apps/api/migrations ./migrations
# Migrationen werden über sqlx::migrate! in die Binary eingebettet.
RUN cargo build --release --locked --bin initiative-api --bin seed

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --create-home initiative

COPY --from=builder /build/target/release/initiative-api /usr/local/bin/initiative-api
COPY --from=builder /build/target/release/seed /usr/local/bin/initiative-seed

USER initiative
WORKDIR /home/initiative
ENV HOST=0.0.0.0 PORT=8080 NODE_ENV=production RUST_LOG=initiative_api=info
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1

CMD ["initiative-api"]
