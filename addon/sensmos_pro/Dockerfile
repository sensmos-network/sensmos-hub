# Dodatek Sensmos Pro: zrodla hubu z publicznego repo (tag), uruchomione w trybie agenta nadzoru (HUB_MODE=pro).
# Kontekst budowy dodatku HA = ten katalog, wiec kod pobieramy z tagu, jak w sensmos_hub.
ARG BUILD_FROM=node:22-alpine
FROM ${BUILD_FROM}
ARG HUB_VERSION=v0.3.0-beta3
RUN apk add --no-cache iputils iproute2 \
 && wget -qO /tmp/hub.tar.gz "https://github.com/sensmos-network/sensmos-hub/archive/refs/tags/${HUB_VERSION}.tar.gz" \
 && mkdir -p /app && tar xzf /tmp/hub.tar.gz -C /app --strip-components=1 && rm /tmp/hub.tar.gz
WORKDIR /app
RUN npm install --omit=dev --no-audit --no-fund
COPY run.sh /run.sh
RUN chmod +x /run.sh
ENV HUB_DATA=/data
CMD ["/run.sh"]
