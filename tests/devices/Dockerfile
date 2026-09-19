# One "device": a Linux machine with the compiled axis binary, a developer
# account, and e2fsprogs for inspecting immutable flags. The root daemon (kernel
# tier, chattr +i) runs as root; the developer and their agents never are.
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends e2fsprogs git ca-certificates procps && rm -rf /var/lib/apt/lists/*
ARG AXIS_BIN=axis-linux-arm64
COPY ${AXIS_BIN} /usr/local/libexec/axis/axis
RUN chmod 755 /usr/local/libexec/axis/axis && ln -s /usr/local/libexec/axis/axis /usr/local/bin/axis \
 && useradd -m -s /bin/bash dev
COPY seed /seed
