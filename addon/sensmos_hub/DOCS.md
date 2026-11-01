# Sensmos Hub add-on

Runs a Sensmos node on this Home Assistant machine. No ESP32 needed. The node registers to your
wallet, measures your home link and opens the encrypted tunnel from the Sensmos app to this Home
Assistant (and other devices on your LAN) without port forwarding or VPN.

## Options

- **owner**: the wallet address from the Sensmos app (Wallet screen), `0x…`.
- **pin**: six digits the app asks for when pairing. Leave empty for a random PIN (see the add-on log).
- **port**: LAN port the app talks to when pairing (default 80, like an ESP32 node). The add-on uses host
  networking, so the port must be free on this machine.

## After the first start

1. The node appears in the Sensmos app on the node list of that wallet.
2. Open it → **Settings → Remote access → Pair** while the phone is on the same LAN; enter the PIN.
3. Add the **HA panel** integration on the node card and point it at this machine's LAN address and
   port 8123.

The hub has no radio, so it does not relay LoRa frames and does not earn GALU.
