# syntax=docker/dockerfile:1

FROM itzg/minecraft-server:latest

ENV TAILSCALE_STATE_DIR=/var/lib/tailscale/tailscaled.state
ENV SERVER_PORT=8081
ENV TYPE=PAPER
# Get the jar from https://www.spigotmc.org/resources/dynmap®.274/updates
# Match the VERSION here (for minecraft version) to the compatible version of Dynmap you downloaded
ENV VERSION=1.21.7

# HTTP Proxy configuration - directs all HTTP/HTTPS traffic through the proxy
# AWS_ENDPOINT_URL is set dynamically via container envVars in container.ts
# Defaults to worker URL (/r2 endpoint) or falls back to localhost:3128 if no worker URL available

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        curl \
        ca-certificates \
        sudo \
    && curl -fsSL https://tailscale.com/install.sh | sh \
    && mkdir -p $(dirname "${TAILSCALE_STATE_DIR}") \
    && mkdir -p /data/plugins \
    && echo "minecraft ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/minecraft \
    && chmod 0440 /etc/sudoers.d/minecraft \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY start-with-services.sh /usr/local/bin/start-with-services.sh
COPY dynmap-configuration.txt /dynmap-configuration.txt
COPY Dynmap-3.7-beta-11-spigot.jar /data/plugins/dynmap.jar
COPY optional_plugins/ /data/optional_plugins/
COPY http-proxy-x64 /usr/local/bin/http-proxy-x64
COPY http-proxy-arm64 /usr/local/bin/http-proxy-arm64
COPY file-server-x64 /usr/local/bin/file-server-x64
COPY file-server-arm64 /usr/local/bin/file-server-arm64
COPY hteetp-linux-x64 /usr/local/bin/hteetp-linux-x64
COPY hteetp-linux-arm64 /usr/local/bin/hteetp-linux-arm64
RUN chmod +x /usr/local/bin/start-with-services.sh \
    && chmod +x /usr/local/bin/http-proxy-x64 \
    && chmod +x /usr/local/bin/http-proxy-arm64 \
    && chmod +x /usr/local/bin/file-server-x64 \
    && chmod +x /usr/local/bin/file-server-arm64 \
    && chmod +x /usr/local/bin/hteetp-linux-x64 \
    && chmod +x /usr/local/bin/hteetp-linux-arm64 \
    && mkdir -p /run/tailscale \
    && chown -R 1000:1000 /data \
    && chown -R 1000:1000 /run/tailscale

USER 1000:1000

EXPOSE 8080 8081 8082 8083 8084 8085 8086 8087 8088 8089 8090 8091 8092 8093 8094 8095 8096 8097 8098 8099 8100 8101 8102 8103 8104 8105 8106 8107 8108 8109 8114 25575

ENTRYPOINT ["/usr/local/bin/start-with-services.sh"]
CMD ["/image/scripts/start"]
