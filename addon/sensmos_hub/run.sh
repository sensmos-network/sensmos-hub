#!/bin/sh
# Home Assistant add-on: opcje z /data/options.json → zmienne środowiskowe hubu. Dane hubu też w /data.
set -e
opt() { node -e "const o=require('/data/options.json');process.stdout.write(String(o[process.argv[1]]??''))" "$1"; }
export HUB_OWNER="$(opt owner)"
export HUB_PIN="$(opt pin)"
export HUB_PORT="$(opt port)"
export HUB_LORA_KEY="$(opt lora_key)"
export HUB_LORAWAN_FORWARD="$(opt lorawan_forward)"
export HUB_LORAWAN_DEVADDR="$(opt lorawan_devaddr)"
export HUB_ESPHOME_LORA="$(opt esphome_lora)"
export HUB_MESHTASTIC_TRACK="$(opt meshtastic_track)"
export HUB_OUTDOOR="$(opt outdoor_sensors)"
export HUB_DATA=/data
exec node /app/src/index.js
