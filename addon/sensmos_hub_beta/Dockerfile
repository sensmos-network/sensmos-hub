# Add-on beta: to samo co sensmos_hub, ale HUB_VERSION wskazuje tag testowy (v0.1.x-betaN), gdy taki jest.
# Kontekst budowy add-onu HA = ten katalog, więc źródła hubu pobieramy z publicznego repo (tag),
# zamiast polegać na obrazie z GHCR (pakiety organizacji nie mogą być publiczne).
ARG BUILD_FROM=node:22-alpine
FROM ${BUILD_FROM}
ARG HUB_VERSION=v0.1.1
RUN apk add --no-cache iputils iproute2 \
 && wget -qO /tmp/hub.tar.gz "https://github.com/sensmos-network/sensmos-hub/archive/refs/tags/${HUB_VERSION}.tar.gz" \
 && mkdir -p /app && tar xzf /tmp/hub.tar.gz -C /app --strip-components=1 && rm /tmp/hub.tar.gz
WORKDIR /app
RUN npm install --omit=dev --no-audit --no-fund
COPY run.sh /run.sh
RUN chmod +x /run.sh
ENV HUB_DATA=/data
CMD ["/run.sh"]
