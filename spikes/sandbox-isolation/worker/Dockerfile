# The worker image.
#
# secure-box-and-supervision.md requires verified and pinned worker images, minimal mounts,
# and a non-root workload. Three things here are load-bearing rather than hygiene:
#
#   1. The base is pinned by digest, not by tag. `node:22` moves; a tag is a promise and a
#      digest is a fact, and the evidence bundle (contracts §10) records the digest a task
#      actually ran on. If this line ever becomes a bare tag, that record stops meaning
#      anything.
#   2. The workload runs as an unprivileged user with no sudo and no package manager
#      credentials. Root inside a container is not root on the host, but it is one kernel
#      bug away from mattering, and it makes every other control softer than it looks.
#   3. Nothing is installed beyond the toolchain. The escape suite is plain Node, precisely
#      so the image does not need curl, netcat or ss — tools whose absence should not be
#      mistaken for isolation.
FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

# git is needed to materialise a repository at a base SHA; nothing else is.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable

# uid/gid are fixed so a bind mount's ownership is predictable across hosts.
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin worker \
 && mkdir -p /work /evidence \
 && chown -R worker:worker /work /evidence

# Baked in rather than copied at run time: the workspace runs with a read-only rootfs, and
# `docker cp` refuses a read-only container outright. Relaxing --read-only to get the probe in
# would have meant measuring a weaker sandbox than the one the design calls for.
# Build context is the spike root, not worker/, so this path resolves.
COPY escape/escape-suite.mjs /opt/escape-suite.mjs

USER worker
WORKDIR /work

ENV PNPM_HOME=/home/worker/.local/share/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
ENV npm_config_update_notifier=false

# No ENTRYPOINT that does work. The supervisor drives the container explicitly, so an image
# that started doing things on its own would be running before any policy check had happened.
CMD ["sleep", "infinity"]
