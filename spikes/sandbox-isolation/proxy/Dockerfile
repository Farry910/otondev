# The egress proxy.
#
# Same pinned base as the worker so the spike pulls one image, and so the proxy cannot
# accidentally be the thing with the larger attack surface. It runs unprivileged and has no
# tools beyond Node either.
FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

# Named `egress`, not `proxy`: Debian already ships a system user called `proxy` (uid 13),
# and useradd exits 9 rather than doing anything clever about it.
RUN useradd --create-home --uid 10002 --shell /usr/sbin/nologin egress \
 && mkdir -p /egress \
 && chown -R egress:egress /egress

COPY allowlist-proxy.mjs /opt/allowlist-proxy.mjs

USER egress
EXPOSE 3128
ENTRYPOINT ["node", "/opt/allowlist-proxy.mjs"]
