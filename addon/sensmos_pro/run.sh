#!/bin/sh
# Dodatek Sensmos Pro: ten sam kod co Sensmos Hub, w trybie agenta nadzoru (src/pro.js). Bez portfela i GALU.
set -e
opt() { node -e "const o=require('/data/options.json');process.stdout.write(String(o[process.argv[1]]??''))" "$1"; }
export HUB_MODE=pro
export HUB_PRO_CODE="$(opt installer_code)"
export HUB_PRO_NAME="$(opt site_name)"
export HUB_PRO_LAN="$(opt lan_checks)"
export HUB_PRO_CONTROL="$(opt allow_control)"
export HUB_PRO_UI="$(opt allow_remote_ui)"
export HUB_PRO_DEVICES="$(opt scan_devices)"
export HUB_DATA=/data
exec node /app/src/index.js
