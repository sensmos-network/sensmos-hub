# Sensmos Pro

Remote care of this Home Assistant by the person who installed and maintains it.

Your installer sees in the Sensmos Pro panel (sensmos.com/pro) whether this Home Assistant is running,
which devices and integrations stopped working (for example Modbus from an inverter or a heat pump),
pending updates, free disk space and the date of the last backup, and gets an alert on the phone
before you notice anything.

- **Remote actions only signed by your installer.** Restart, reload an integration, backup, update, run a service,
  add an automation from a template, read the log. Each action is signed by the installer's account key, which the
  add-on pins on first connection, so not even the Sensmos server can send one. Turn off **Allow remote actions**
  to make the supervision read only.
- **No wallet, no tokens, no crypto.** This is not a Sensmos network node and earns nothing.
- **What leaves your home:** the Home Assistant version and state, the number of entities, the names of
  entities that are unavailable, integrations with errors, pending updates, disk and backup info,
  results of the local network checks, and the current values of only those entities your installer
  chose to watch. Nothing else.
- **To stop the supervision**, stop or uninstall this add-on. The installer can also remove the site in the panel.

## Setup

1. Install the add-on and paste the **installer code** (SP-XXXX-XXXX) from your installer.
2. Optionally name the site and list local devices to watch.
3. Start the add-on. The site appears in the installer's panel within a minute.

## Docker / probe without Home Assistant

The same agent runs in Docker on any Linux box (Raspberry Pi, mini PC, NAS) as a network probe for IT
support: `HUB_MODE=pro`, `HUB_PRO_CODE=SP-XXXX-XXXX`, `HUB_PRO_LAN="nas=192.168.1.5:445,printer=192.168.1.20:9100"`.
With `HUB_HA_URL` and `HUB_HA_TOKEN` it also reports a Home Assistant in that network.
