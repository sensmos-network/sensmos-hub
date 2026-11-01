# Kontekst budowy add-onu HA = ten katalog, więc bierzemy gotowy obraz hubu z GHCR i dokładamy tylko start z opcjami.
ARG BUILD_FROM=ghcr.io/sensmos-network/sensmos-hub:0.1
FROM ${BUILD_FROM}
COPY run.sh /run.sh
RUN chmod +x /run.sh
ENV HUB_DATA=/data
CMD ["/run.sh"]
