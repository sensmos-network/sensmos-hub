# Sensmos Hub

A Sensmos node without an ESP32. Runs on a Raspberry Pi, NAS or any Linux box with Docker, registers
to your wallet like a normal node, measures your home link and opens the encrypted tunnel from the
Sensmos app to devices on your LAN, for example the Home Assistant panel, without port forwarding,
VPN or a public IP.

**Version 0.1, early.** It speaks the same protocol as the firmware (`kontrakt/protokol/`), so the
backend and the app treat it as a node. It has no radio, so it does not relay LoRa frames and does
not earn GALU; it is reported to the backend as kind `hub`.

## What you need

- Docker with Compose on a machine that is always on, in the same LAN as the devices you want to reach.
- The Sensmos app with a wallet. The hub is registered to the wallet address you put in `.env`.

## Quick start

```sh
git clone https://github.com/sensmos-network/sensmos-hub.git
cd sensmos-hub
cp .env.example .env        # put your wallet address in HUB_OWNER
docker compose up -d
docker compose logs -f      # shows the device_id and the PIN
```

The container uses host networking: the app finds the hub by mDNS (`sensmos-<id>.local`) and talks to it on
port 80 like to an ESP32 node, the tunnel reaches your LAN, and `ping` measures the real home link. Port 80
must be free on the host.

After the first start the hub appears in the app on the node list of that wallet.

## Pairing and the tunnel

1. In the app open the hub → **Settings → Remote access → Pair** while the phone is on the same LAN.
   The app asks for the PIN (from the log or `data/pin.txt`) and writes a pairing key onto the hub.
   The key never leaves your LAN; the Sensmos server never sees it.
2. Add the **HA panel** or **LAN panel** integration on the node card and point it at a private
   address, for example `192.168.1.20:8123`.

Everything that goes through the tunnel is encrypted end to end with a key derived from the pairing
key (`tunel.md`); the server only forwards opaque frames. Only private addresses are reachable.

## Home Assistant add-on

The same hub as an add-on, for people who run Home Assistant OS or Supervised:

1. Settings → Add-ons → Add-on store → ⋮ → **Repositories** → add `https://github.com/sensmos-network/sensmos-hub`.
2. Install **Sensmos Hub**, fill in **owner** (wallet address) and optionally **pin**, start it.
3. Pair from the app as above; the HA panel integration then points at this machine, port 8123.

Home Assistant builds the add-on image itself from this repository (`addon/sensmos_hub/`), with host networking.

## Test builds (beta)

Testers get new hub versions first. A test build is a tag like `v0.1.2-beta1`; the stable add-on and
the `main` instructions above move to it only after testers have checked it.

- **Home Assistant:** in the same repository install **Sensmos Hub (beta)** instead of **Sensmos Hub**.
  It is a separate node with its own device id, so pair it again; stop the stable add-on first (both use port 80).
- **Docker Compose:** check out the test tag and rebuild. The `data/` folder stays, so the node keeps its identity.

```sh
git fetch --tags
git checkout v0.1.2-beta1        # the newest -beta tag; back to stable: git checkout main
docker compose up -d --build
```

## Diagnostics and the testers programme

The hub keeps its last 500 log lines in `data/events.json`. One command builds a diagnostic package
(version, device, config without secrets, events, errors, metrics) and, with `--upload`, sends it to
the backend signed with the hub's own key, so it counts for the testers programme:

```sh
docker compose exec hub node src/index.js diag                      # print the package
docker compose exec hub node src/index.js diag --upload             # send it
docker compose exec hub node src/index.js diag --upload --scenario hub-install --result ok --note "worked"
```

`SENSMOS_LOG=debug` in `.env` logs every message from the backend (tester mode).

## Files in `data/`

| file | what |
|---|---|
| `identity.json` | the hub's key pair; delete it to get a new identity (a new node) |
| `pairing.json` | pairing keys written by phones (up to 4) |
| `pin.txt` | the PIN, when `HUB_PIN` is empty |
| `registered.json` | marker that the hub registered with the backend for this wallet |
| `events.json`, `state.json` | last 500 log lines and process state, read by `diag` |

## What works in 0.1 and what does not

Works: registration, encrypted channel, heartbeat, link measurements (icmp via `ping`, tcp, http, dns),
pairing over LAN, tunnel v2 to private addresses.

Not yet: traceroute jobs, LoRa, MQTT broker, local data history, Home Assistant add-on packaging.

## Development

```sh
npm install
npm test          # protocol vectors from kontrakt/protokol/wektory + LAN API
HUB_OWNER=0x… HUB_BE=http://localhost:3000 node src/index.js
```
