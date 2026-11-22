# Sensmos Hub

A Sensmos node without an ESP32. Runs on a Raspberry Pi, NAS or any Linux box with Docker, registers
to your wallet like a normal node, measures your home link and opens the encrypted tunnel from the
Sensmos app to devices on your LAN, for example the Home Assistant panel, without port forwarding,
VPN or a public IP.

**Stable 0.2.0 (Home Assistant add-on and Docker); test builds come as 0.2.x-beta first.** It speaks the same protocol as the firmware (`kontrakt/protokol/`), so the
backend and the app treat it as a node. It has no radio, so it does not relay LoRa frames; it is
reported to the backend as kind `hub`. It can still receive your LoRa sensors through the network
(from 0.2.0-beta2, see below).

**GALU allocation (from 0.1.2, beta first).** A hub receives GALU at half the weight of an ESP32 node once its
owner confirms it from the Sensmos app: open the hub's card while the phone is on the **same Wi-Fi**
as the hub and tap **Confirm hub**. The app asks the hub (with its PIN) to sign a one-time challenge,
signs it with the wallet and sends the phone's location; the backend accepts it only when the phone
and the hub reach the internet from the same address. Several hubs behind one address share one
hub allocation.

**No Android phone (from 0.2.0-beta8):** confirm the hub in the browser instead. Open
[sensmos.com/my](https://sensmos.com/my/) in the MetaMask app (iPhone works) on the same Wi-Fi as the hub,
open the hub and tap **Confirm hub**, enter the hub PIN (`docker compose logs hub | grep PIN`) and sign once
in MetaMask. The page cannot reach the hub in your LAN, so the backend passes the request to the hub over the
hub's own encrypted connection (`attest_req`); the hub signs the same challenge only with the right PIN
(5 wrong PINs lock it for 15 minutes), and the backend still checks the wallet signature and the same address.

## What you need

- Docker with Compose on a machine that is always on, in the same LAN as the devices you want to reach.
- The Sensmos app with a wallet. The hub is registered to the wallet address you put in `.env`.

## Quick start

```sh
git clone https://github.com/sensmos-network/sensmos-hub.git
cd sensmos-hub
cp .env.example .env        # wallet address in HUB_OWNER, or leave it empty and add the hub from the app (0.2.0-beta4+)
docker compose up -d
docker compose logs -f      # shows the device_id and the PIN
```

The container uses host networking: the app finds the hub by mDNS (`sensmos-<id>.local`) and talks to it on
port 80 like to an ESP32 node, the tunnel reaches your LAN, and `ping` measures the real home link. Port 80
must be free on the host.

After the first start the hub appears in the app on the node list of that wallet.

**Without the wallet address (from 0.2.0-beta4):** leave `HUB_OWNER` empty. The hub waits on your LAN; in the app
(1.6.7+) open **Nodes → Add → Search the network**, pick the hub and enter the PIN from the log. The app assigns it to
your wallet (`POST /node/owner`, PIN, LAN only); the hub keeps it in `data/owner.json`, registers and connects.

## Pairing and the tunnel

1. In the app open the hub → **Settings → Remote access → Pair** while the phone is on the same LAN.
   The app asks for the PIN (from the log or `data/pin.txt`) and writes a pairing key onto the hub.
   The key never leaves your LAN; the Sensmos server never sees it.
2. Add the **HA panel** or **LAN panel** integration on the node card and point it at a private
   address, for example `192.168.1.20:8123`.

Everything that goes through the tunnel is encrypted end to end with a key derived from the pairing
key (`tunel.md`); the server only forwards opaque frames. Only private addresses are reachable.

## Home Assistant add-on

The same hub as an add-on, for people who run Home Assistant OS or Supervised. One click adds the
repository and opens the add-on:

[![Open the Sensmos Hub add-on in my Home Assistant](https://my.home-assistant.io/badges/supervisor_addon.svg)](https://my.home-assistant.io/redirect/supervisor_addon/?addon=ea77c6f9_sensmos_hub&repository_url=https%3A%2F%2Fgithub.com%2Fsensmos-network%2Fsensmos-hub)

1. Press the button (or Settings → Add-ons → Add-on store → ⋮ → **Repositories** → add `https://github.com/sensmos-network/sensmos-hub`).
2. **Install**, paste your wallet address from the Sensmos app into **Wallet address**, **Start**.
3. Pair from the app as above (PIN in the add-on log); the HA panel integration then points at this machine, port 8123.

Step-by-step guide: https://sensmos.com/ha/ . Home Assistant builds the add-on image itself from this
repository (`addon/sensmos_hub/`), with host networking.

## Test builds (beta)

Testers get new hub versions first. A test build is a tag like `v0.2.0-beta3`; the stable add-on and
the `main` instructions above move to it only after testers have checked it.

- **Home Assistant:** in the same repository install **Sensmos Hub (beta)** instead of **Sensmos Hub**.
  It is a separate node with its own device id, so pair it again; stop the stable add-on first (both use port 80).
- **Docker Compose:** check out the test tag and rebuild. The `data/` folder stays, so the node keeps its identity.

```sh
git fetch --tags
git checkout v0.2.0-beta3        # the newest -beta tag (git tag -l "*-beta*"); back to stable: git checkout main
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
| `owner.json` | wallet assigned from the app (when `HUB_OWNER` is empty) |
| `registered.json` | marker that the hub registered with the backend for this wallet |
| `shared.json` | which Home Assistant sensors you chose to share |
| `lora.json` | LoRa: SHA-256 of the key phrase (never the phrase), plain-frames opt-in, last frames |
| `history.jsonl` | the last 7 days of shared sensor readings, kept only here |
| `events.json`, `state.json` | last 500 log lines and process state, read by `diag` |

## Home Assistant sensors (from 0.2.0-beta1)

The hub reads the sensors Home Assistant already knows (ESPHome, Zigbee, MQTT, anything with a numeric
state or on/off), read-only and over your LAN. Nothing leaves your home until you tick a sensor as shared in
the app (hub card → Hub sensors). Shared readings go to the network every 5 minutes, the same way an ESP32
node sends its data: temperature, humidity, pressure, CO₂, PM, noise, door/window, motion/presence, power,
voltage and battery map to the standard Sensmos entities; anything else is kept as your own data.

- **Add-on:** works on its own through Home Assistant's built-in API.
- **Docker:** set `HUB_HA_URL` (for example `http://192.168.1.10:8123`) and `HUB_HA_TOKEN` (a long-lived
  access token from your HA profile) in `.env`.

The log shows what the hub sees (`HA (add-on): 12 sensors: …`), and the app can read the same list from
the hub with its PIN (`GET /sensors`).

The hub also keeps the last 7 days of shared readings on its own disk (`GET /data/history`) and answers
`/data/status` and `/data/native` like an ESP32 node, so the Sensmos integration for Home Assistant can add it
as a physical node.

## LoRa sensors in Home Assistant (from 0.2.0-beta2)

The hub has no radio, yet LoRa sensors can report to it. A sensor sends DATA frames (`0xE0 0x02`) to the
hub's id8, the first 8 characters of its device id (logged at start: `LoRa: sensors send to id …`). Any
Sensmos node within radio range hears the frame and the backend forwards it, still encrypted, to the hub
over its WebSocket. The hub decrypts it with your key phrase exactly like an ESP32 base (AES-256-CTR, key =
SHA-256 of the phrase) and sends back a receipt with metadata only. The backend never has the key.

- **Key phrase:** add-on option `lora_key`, `HUB_LORA_KEY` in `.env`, or the app (hub card → LoRa → frame
  reception, `POST /node/lora_rx`). Plain frames are refused unless you opt in there, like on the firmware.
- **Home Assistant entities, no HACS needed:** each sub-address becomes `sensor.sensmos_lora_<sub>` (last
  payload; a number stays a number). Payloads of `key=value` pairs separated by `;`, `,` or spaces, such as
  `t=21.5;h=40;bat=87`, also give one entity per key: `t`/`temp` °C, `h`/`hum`/`rh` %, `p`/`pres` hPa,
  `bat`/`batt` %, `v`/`vbat` V, `co2` ppm, `lux` lx, `pm25`/`pm10` µg/m³; other keys without a unit. Every
  frame also fires the `sensmos_lora_frame` event. The hub rewrites the states every 5 minutes, so they come
  back after a Home Assistant restart. Docker needs `HUB_HA_URL` + `HUB_HA_TOKEN`; `HUB_LORA_HA=0` turns it off.
- **Sensor went silent:** each sub-address also gets `binary_sensor.sensmos_lora_<sub>_silent` (device class
  `problem`). It turns `on` when no frame came for 3 of the sensor's usual intervals (at least 1 hour, at most
  2 days; the usual interval is the longest of the last 8, so an event sensor with a 12 h heartbeat, like a
  mailbox, is not called silent an hour after two quick frames), and the hub fires `sensmos_lora_silent` once, then `sensmos_lora_back` on the next frame. Good for a
  garage or allotment guard: a dead battery or a removed board raises an alarm too. Recipe:
  [sensmos-esphome](https://github.com/sensmos-network/sensmos-esphome#recipe-garage--allotment-guard).
- **Meters (0.2.0-beta6):** the keys `kwh`, `m3`/`water` and `gas` become `total_increasing` sensors with the
  right device class and unit, so Home Assistant takes them straight into the **Energy** dashboard; `w`/`kw` are
  power. Recipe for an electricity meter (LED pulses) and a water meter (pulse output) in the basement:
  [sensmos-esphome](https://github.com/sensmos-network/sensmos-esphome#recipe-meters-in-the-basement).
- **Garden and apiary (0.2.0-beta6):** `soil` becomes a moisture sensor in %, and `kg` a weight sensor (a beehive on a load cell).
- **Weather station (0.2.1-beta1):** `rain` becomes precipitation in mm (`total_increasing`, so a daily `utility_meter` gives the day's rain), `wind` and `gust` wind speed in m/s.
- **Second probe (0.2.0-beta6):** `t2`…`t9`, `h2`… get the same class and unit as `t` and `h` (a cold room and a freezer on one board).
- **Water level for the neighbourly alert (0.2.0-beta6):** a shared Home Assistant sensor whose name says water
  level (`water_level`, `poziom_wody`, `Wasserstand`, `Pegel`, `nível da água`) with a unit of cm, m or mm goes to
  the network as `water_level` in cm. Neighbours who turned on the water alert in the app get a notification when it
  rises fast near them. It only says the station's pseudonym and distance, never who you are.
- **Outdoor sensors (0.2.0):** a shared temperature or humidity sensor whose name says it is outside (`outdoor`,
  `balcony`/`balkon`, `garden`/`ogród`/`Garten`, `zewn…`, `außen`, `exterior`, `jardim`, `dış`, `bahçe`, `weather`…)
  goes to the network as `temp_out` / `humidity_out` instead of `temp_in` / `humidity_in`. Set `HUB_OUTDOOR`
  (add-on: `outdoor_sensors`) to list entity ids that are outside (`sensor.probe_2`), `-sensor.x` for one that is
  inside despite its name, or `none` to turn the name guess off.
- **Meshtastic bridge (0.2.0-beta6):** Meshtastic messages and sensors in Home Assistant, without the hub transmitting
  anything. Turn on MQTT with **JSON enabled** on a Meshtastic node with Wi-Fi and point it at the Home Assistant
  broker, then add the automation below. Every text message becomes `sensor.meshtastic_<id>` and the event
  `sensmos_meshtastic_message` (`node`, `name`, `text`, `channel`, `rssi`, `snr`); telemetry becomes
  `sensor.meshtastic_<id>_t`, `_h`, `_p`, `_bat`, `_v`, `_lux`, `_ma` (current), `_iaq`. Positions are stored only for
  nodes you list in `HUB_MESHTASTIC_TRACK` (add-on: `meshtastic_track`, e.g. `!7efeee00, !7efeee01`, from 0.2.0-beta7):
  your own and your family's, with their consent. Each gets `sensor.meshtastic_<id>_where` with `latitude` and
  `longitude`, so the HA map card shows it. Positions of every other node are dropped. `HUB_MESHTASTIC=0` turns the bridge off.

  ```yaml
  rest_command:
    sensmos_meshtastic:
      url: "http://127.0.0.1:80/meshtastic"        # add-on; Docker: http://<hub-ip>:<HUB_PORT>/meshtastic
      method: POST
      headers: { Authorization: "Bearer 123456" }  # the hub PIN
      content_type: application/json
      payload: "{{ payload }}"
  automation:
    - alias: Meshtastic to Sensmos Hub
      trigger: { platform: mqtt, topic: "msh/+/2/json/#" }
      action: { service: rest_command.sensmos_meshtastic, data: { payload: "{{ trigger.payload }}" } }
  ```
- **Other people's LoRaWAN sensors, narrow version (0.2.0-beta7):** a ready LoRaWAN sensor (Dragino, Milesight, a
  Heltec with LMIC…) in Home Assistant through your own ChirpStack or The Things Stack, with no LoRaWAN gateway of
  your own. Sensmos nodes already pass on the foreign frames they hear; set `HUB_LORAWAN_DEVADDR` (add-on:
  `lorawan_devaddr`, comma separated, as ChirpStack shows them) and the network sends the hub only the frames with
  those addresses. The hub forwards them like a gateway (Semtech UDP) to `HUB_LORAWAN_FORWARD` (`lorawan_forward`,
  e.g. `192.168.1.10:1700` for ChirpStack's Gateway Bridge or `eu1.cloud.thethings.network:1700`). Register the
  gateway EUI from the log line `LoRaWAN: gateway EUI …`. ChirpStack checks the MIC and the counter, decodes with the
  device's own codec and gives it to HA over MQTT (or the HA *The Things Network* integration). The keys never
  leave your ChirpStack. Uplink only, so **ABP only** (OTAA needs a Join Accept downlink); keep the sensor on a
  channel the nodes hear, ideally 868.1 MHz DR1 (SF11, the Sensmos home channel), and turn off the frame counter
  check only if the sensor resets it.
- **Plain ESPHome over the Sensmos network (0.2.0-beta7):** a board running only stock ESPHome, with no Sensmos
  component, sends with ESPHome's own `packet_transport` over the `sx126x` radio on the Sensmos home channel
  (868.1 MHz, SF11, BW 125 kHz, CR 4/5, sync `0x34 0x44`). Nodes hear it like any foreign frame. Set
  `HUB_ESPHOME_LORA` (add-on: `esphome_lora`) to `name=sub:encryption`, `;` between boards, e.g.
  `allotment-sensor=20:my-secret`: the network sends the hub only frames with those board names, and the hub
  decrypts them (XXTEA, the key hashed from the `encryption` string, as ESPHome does) and shows each value as
  `sensor.sensmos_lora_<sub>_<id>`, with the silence alert, the events and the history of any LoRa sensor.
  `rolling_code_enable: true` on the board is honoured (replayed frames are dropped); leave `ping_pong_enable` off,
  it needs a two-way link. The board name travels in clear (that is how packet_transport works), so pick one that
  says nothing about you. Example: `examples/lora-zwykle-esphome.yaml` in sensmos-esphome.
- **Where is my tag (0.2.0-beta7):** every LoRa sensor also gets `sensor.sensmos_lora_<sub>_heard`: the id of the
  Sensmos node that heard its last frame, with RSSI, SNR and that node's position rounded to about 1 km as
  `latitude`/`longitude` attributes, so the HA map card shows roughly where the sensor is. A bag, a bike or a dog
  collar with a small LoRa board is found the way a Find My tag is, just through Sensmos nodes. Nodes that hide
  their location send no position. The `sensmos_lora_frame` event carries `rx` and `near` too.
- **Same API as a board:** `/info` carries a `lora` field, and `/lora/inbox`, `/node/lora_rx`,
  `/node/lora_emerg` answer like the firmware, so the app's LoRa screen and the Sensmos integration for HA
  (LoRa DATA frame sensors) work with the hub too. `/node/lorasend` sends a frame through the network
  (`lora_send`); sending to the hub's own sensors needs a radio and is refused.

## What works in 0.1 and what does not

Works: registration, encrypted channel, heartbeat, link measurements (icmp via `ping`, tcp, http, dns),
pairing over LAN, tunnel v2 to private addresses.

Not yet: traceroute jobs, LoRa radio (receiving LoRa sensors through the network works from 0.2.0-beta2), MQTT broker.

## Development

```sh
npm install
npm test          # protocol vectors from kontrakt/protokol/wektory + LAN API
HUB_OWNER=0x… HUB_BE=http://localhost:3000 node src/index.js
```
