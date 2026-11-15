# Sensmos Hub (beta) add-on

Test builds of the Sensmos Hub for the testers programme (https://sensmos.com/test/). This add-on
gets a new hub version as soon as it is tagged for testing; the stable **Sensmos Hub** add-on gets it
only after testers have checked it. When no test build is out, both run the same version.

**It is a separate node.** Home Assistant keeps each add-on's data apart, so the beta add-on has its
own device id and has to be paired again. Both use port 80 by default: stop the stable add-on first,
or give one of them another port.

## Options

- **owner**: optional from 0.2.0-beta4. Leave it empty and add the hub from the app (below), or paste the wallet address from the Sensmos app (Wallet screen), `0x…`.
- **pin**: six digits the app asks for when pairing. Leave empty for a random PIN (see the add-on log).
- **port**: LAN port the app talks to when pairing (default 80).
- **lora_key**: the key phrase of your LoRa sensors (optional, from 0.2.0-beta2). See below.

## Adding the hub from the app, without the wallet address (from 0.2.0-beta4)

1. Start the add-on with **owner** empty. Home Assistant shows a notification **Sensmos Hub is ready** with the PIN.
2. With the phone on the same Wi-Fi, open the Sensmos app (1.6.7 or newer): **Nodes → Add → Search the network**, pick the hub and enter the PIN.
3. The app assigns the hub to your wallet, the hub registers and connects, and the notification disappears.

The assignment is kept in the add-on data. A hub that already has an owner refuses another wallet; to give it
to someone else, remove the node from the account in the app and restart the add-on.

## LoRa sensors without a radio (from 0.2.0-beta2)

The hub has no radio, but your LoRa sensors can still report to this Home Assistant. A sensor sends its
DATA frames to the hub's id (the 8 characters in the log line `LoRa: sensors send to id …`), any Sensmos
node within radio range hears them, and the network delivers them to the hub over the internet. The
frames stay encrypted on the way: only the hub, with your key phrase, can read them.

- Set the key phrase in **lora_key** or in the app (hub card → LoRa → frame reception).
- Each sensor sub-address shows up as `sensor.sensmos_lora_<sub>`. A payload like `t=21.5;h=40;bat=87`
  also gives `sensor.sensmos_lora_<sub>_t`, `…_h`, `…_bat` with units (t °C, h %, p hPa, bat %, v V, co2 ppm, lux).
- Every frame fires the `sensmos_lora_frame` event for automations.
- `binary_sensor.sensmos_lora_<sub>_silent` turns on when a sensor stops sending (no frame for 3 of its usual
  intervals, at least 1 hour). The hub then fires `sensmos_lora_silent`, and `sensmos_lora_back` when it returns.
- Meter keys `kwh`, `m3` (or `water`) and `gas` are counters (`total_increasing`) that the Energy dashboard accepts;
  `w` and `kw` are power.
- A shared sensor named like a water level (`water_level`, `poziom_wody`, `Wasserstand`, `Pegel`) in cm, m or mm is
  sent as `water_level` (cm) for the neighbourly water alert.
- Meshtastic positions on the HA map: list your own or family nodes in **meshtastic_track** (`!7efeee00, …`);
  only they get `sensor.meshtastic_<id>_where` with latitude/longitude. Other nodes' positions are never kept.
- Meshtastic bridge: an automation with an MQTT trigger on `msh/+/2/json/#` that calls a `rest_command` posting the
  payload to `http://127.0.0.1:80/meshtastic` with `Authorization: Bearer <hub PIN>` gives you `sensor.meshtastic_*`
  and the `sensmos_meshtastic_message` event. The hub only listens; it never transmits. Full example in the README.
- Other people's LoRaWAN sensors (ABP only, uplink only): put their DevAddr in **lorawan_devaddr** (comma separated)
  and your ChirpStack Gateway Bridge or The Things Stack in **lorawan_forward** (`host:1700`). The network sends the
  hub only frames with those addresses and the hub forwards them like a gateway; register the EUI from the log line
  `LoRaWAN: gateway EUI …`. Decoding and the keys stay in ChirpStack. Details in the README.
- Plain ESPHome boards (no Sensmos component): a board with ESPHome's own `packet_transport` over `sx126x` on the
  Sensmos home channel (868.1 MHz, SF11, sync `0x34 0x44`) goes in **esphome_lora** as `name=sub:encryption`
  (`;` between boards). The network sends the hub only frames with those board names; the hub decrypts them and
  shows the readings as `sensor.sensmos_lora_<sub>_<id>`, with silence alerts like any LoRa sensor. Example in the
  README of sensmos-esphome (`lora-zwykle-esphome.yaml`).
- `sensor.sensmos_lora_<sub>_heard`: which Sensmos node heard the sensor last, with its position rounded to about
  1 km for the HA map card (where is my tag).
- No HACS integration needed. If you also use the Sensmos integration with this hub, it shows the same
  frames as **LoRa DATA frame** sensors.

## GALU allocation

From 0.1.2 a confirmed hub receives GALU at half the weight of an ESP32 node. Confirm it once from the
Sensmos app (beta 1.6.4 or newer): hub card → **Confirm hub**, with the phone on the same Wi-Fi as
this Home Assistant. Several hubs behind one internet address share one hub allocation.

## Reporting

Something broke? Send a diagnostic package from the add-on terminal or report it on
https://sensmos.com/test/ with **Does not work**. Confirmed bugs earn bonus points.
