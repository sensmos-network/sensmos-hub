# Sensmos Hub (beta) add-on

Test builds of the Sensmos Hub for the testers programme (https://sensmos.com/test/). This add-on
gets a new hub version as soon as it is tagged for testing; the stable **Sensmos Hub** add-on gets it
only after testers have checked it. When no test build is out, both run the same version.

**It is a separate node.** Home Assistant keeps each add-on's data apart, so the beta add-on has its
own device id and has to be paired again. Both use port 80 by default: stop the stable add-on first,
or give one of them another port.

## Options

- **owner**: the wallet address from the Sensmos app (Wallet screen), `0x…`.
- **pin**: six digits the app asks for when pairing. Leave empty for a random PIN (see the add-on log).
- **port**: LAN port the app talks to when pairing (default 80).

## Rewards

From 0.1.2 a confirmed hub earns GALU at half the weight of an ESP32 node. Confirm it once from the
Sensmos app (beta 1.6.4 or newer): hub card → **Confirm hub**, with the phone on the same Wi-Fi as
this Home Assistant. Several hubs behind one internet address share one hub reward.

## Reporting

Something broke? Send a diagnostic package from the add-on terminal or report it on
https://sensmos.com/test/ with **Does not work**. Confirmed bugs earn bonus points.
