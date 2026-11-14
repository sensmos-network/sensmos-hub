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
- No HACS integration needed. If you also use the Sensmos integration with this hub, it shows the same
  frames as **LoRa DATA frame** sensors.

## Rewards

From 0.1.2 a confirmed hub earns GALU at half the weight of an ESP32 node. Confirm it once from the
Sensmos app (beta 1.6.4 or newer): hub card → **Confirm hub**, with the phone on the same Wi-Fi as
this Home Assistant. Several hubs behind one internet address share one hub reward.

## Reporting

Something broke? Send a diagnostic package from the add-on terminal or report it on
https://sensmos.com/test/ with **Does not work**. Confirmed bugs earn bonus points.
