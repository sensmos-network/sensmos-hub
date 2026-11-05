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

## Reporting

Something broke? Send a diagnostic package from the add-on terminal or report it on
https://sensmos.com/test/ with **Does not work**. Confirmed bugs earn bonus points.
