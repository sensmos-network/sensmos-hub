# Sensmos Hub add-on

Turns this Home Assistant machine into a Sensmos node. No ESP32 and no soldering. The node registers
to your wallet, measures your home link and opens the encrypted tunnel from the Sensmos app to this
Home Assistant (and other devices on your LAN) without port forwarding, VPN or a public IP.

Step-by-step guide with pictures: https://sensmos.com/ha/

## Setup in four steps

1. **Wallet address.** Install the Sensmos app, open **Wallet** and copy your address (`0x…`).
2. **Configuration tab.** Paste it into **Wallet address**. Leave **PIN** empty for a random one.
   Save and press **Start**.
3. **Log tab.** You will see `device_id` and `PIN hubu: 123456`. A minute later the node shows up in
   the app on the node list of your wallet.
4. **Pair the phone.** With the phone on the same Wi-Fi, open the node in the app →
   **Settings → Remote access → Pair** and enter the PIN. Then add the **HA panel** integration on the
   node card: your Home Assistant opens from anywhere through the tunnel.

## Options

- **Wallet address** (`owner`): the wallet address from the Sensmos app, `0x…`.
- **PIN** (`pin`): six digits the app asks for when pairing. Empty = random PIN, shown in the log.
- **LAN port** (`port`): port the app talks to on your network (default 80, like an ESP32 node). The
  add-on uses host networking, so the port must be free on this machine.

## Rewards and Home Assistant sensors

The testers' build (**Sensmos Hub (beta)** in this repository) already earns GALU at half the weight
of an ESP32 node once you confirm it from the app, and can share the sensors Home Assistant knows
(temperature, CO₂, power and more) to the Sensmos map. This stable add-on gets both after testers have
checked them. Join the testers: https://sensmos.com/test/

## Help

Something does not work? Open https://sensmos.com/test/ and use **Does not work**, or ask on the
Sensmos Discord.
