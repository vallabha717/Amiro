# amiro-sandboxd: the only holder of the Docker socket. Build context is
# backend/sandboxd (see compose.yml).
FROM rust:1-bookworm AS build
WORKDIR /src
COPY . .
RUN cargo build --release --locked --bin amiro-sandboxd

FROM debian:bookworm-slim
COPY --from=build /src/target/release/amiro-sandboxd /usr/local/bin/amiro-sandboxd
# Non-root. compose adds the socket's group so it can reach Docker without
# being root; cap_drop ALL and no-new-privileges are set there too.
USER 65532:65532
ENV AMIRO_SANDBOX_LISTEN=0.0.0.0:4313
EXPOSE 4313
ENTRYPOINT ["/usr/local/bin/amiro-sandboxd"]
