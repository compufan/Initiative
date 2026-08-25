# syntax=docker/dockerfile:1
# Initiative API – Rust. Zwei Stufen, damit das Ergebnis nur die Binary enthält.

FROM rust:1-slim-bookworm AS builder
WORKDIR /build

# OpenSSL wird für die Passkey-Anmeldung gebraucht: webauthn-rs prüft die
# Signaturen darüber. Ohne diese Pakete bricht der Build in `openssl-sys` ab,
# noch bevor eine Zeile eigener Code übersetzt wird.
RUN apt-get update \
 && apt-get install -y --no-install-recommends pkg-config libssl-dev \
 && rm -rf /var/lib/apt/lists/*

# Abhängigkeiten zuerst bauen, damit Docker sie zwischen Builds cachen kann.
# Build-Context ist dieses Verzeichnis (apps/api) selbst, nicht das Repo-Root.
COPY Cargo.toml Cargo.lock ./
RUN mkdir -p src/bin \
 && echo 'fn main() {}' > src/main.rs \
 && echo '' > src/lib.rs \
 && echo 'fn main() {}' > src/bin/seed.rs \
 && cargo build --release --locked \
 && rm -rf src \
      target/release/.fingerprint/initiative-api-* \
      target/release/.fingerprint/initiative_api-* \
      target/release/.fingerprint/seed-*

COPY src ./src
COPY migrations ./migrations
# `touch` ist zwingend: COPY übernimmt die Zeitstempel aus dem Build-Context,
# die älter sind als die Platzhalter-Binary von oben. Cargo vergleicht genau
# diese Zeitstempel, hielte den echten Code sonst für unverändert und würde
# stillschweigend die leere `fn main() {}`-Binary ausliefern – die startet
# ohne jede Ausgabe und endet sofort mit Code 0.
# Migrationen werden über sqlx::migrate! in die Binary eingebettet.
RUN find src migrations -type f -exec touch {} + \
 && cargo build --release --locked --bin initiative-api --bin seed

FROM debian:bookworm-slim AS runtime
# Welcher Stand laeuft hier? Wird beim Deploy durchgereicht und in der App
# unter "Ueber" angezeigt, damit man einen Push zuordnen kann.
ARG GIT_SHA=unbekannt
ENV GIT_SHA=$GIT_SHA
# `libssl3` gehört dazu, weil die Binary dynamisch gegen OpenSSL gelinkt ist
# (siehe Kommentar in der Build-Stufe). Ohne das Paket startet sie nicht.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl libssl3 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --create-home initiative

COPY --from=builder /build/target/release/initiative-api /usr/local/bin/initiative-api
COPY --from=builder /build/target/release/seed /usr/local/bin/initiative-seed

# Das Ablageverzeichnis muss dem Dienstbenutzer gehoeren, BEVOR auf ihn
# umgeschaltet wird. Ein leeres Docker-Volume auf einem Pfad, den es im Image
# nicht gibt, gehoert sonst root – und der Dienst scheitert beim ersten
# Upload mit "Permission denied", also erst im Betrieb.
RUN mkdir -p /data/uploads && chown -R initiative:initiative /data

USER initiative
WORKDIR /home/initiative
# RUST_LOG steht hier bewusst NICHT: Es haette Vorrang vor LOG_LEVEL
# (main.rs), und dann waere der Schalter, den die Compose-Datei durchreicht,
# wirkungslos – eine Falle, die man erst bemerkt, wenn man im Fehlerfall
# vergeblich mehr Protokoll einschaltet. Ohne beides gilt derselbe Vorgabewert.
ENV HOST=0.0.0.0 PORT=8080 NODE_ENV=production
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1

CMD ["initiative-api"]
