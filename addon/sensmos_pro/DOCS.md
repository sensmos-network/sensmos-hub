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
- **Remote Home Assistant view.** On the installer's signed command the add-on opens a tunnel to the panel
  server, so the installer sees the full Home Assistant interface in a browser at a separate Sensmos address
  and signs in with their own Home Assistant account (your password is never needed). The tunnel closes after
  30 minutes idle, at the latest after 8 hours. Traffic is encrypted between the browser and the server
  and between the server and this add-on, and the server relays it. Turn off **Allow remote Home Assistant view**
  if you do not want this. If you use the *Trusted networks* sign-in with 127.0.0.1, remove that address, because
  the tunnel reaches Home Assistant from this machine.
- **No wallet, no tokens, no crypto.** This is not a Sensmos network node and earns nothing.
- **What leaves your home:** the Home Assistant version and state, the number of entities, the names of
  entities that are unavailable, integrations with errors, pending updates, disk and backup info,
  results of the local network checks, and the current values of only those entities your installer
  chose to watch. Nothing else, except while the installer has the remote view open.
- **To stop the supervision**, stop or uninstall this add-on. The installer can also remove the site in the panel.

## Setup

1. Install the add-on and paste the **installer code** (SP-XXXX-XXXX) from your installer.
2. Optionally name the site and list local devices to watch.
3. Start the add-on. The site appears in the installer's panel within a minute.

## Docker / probe without Home Assistant

The same agent runs in Docker on any Linux box (Raspberry Pi, mini PC, NAS) as a network probe for IT
support: `HUB_MODE=pro`, `HUB_PRO_CODE=SP-XXXX-XXXX`, `HUB_PRO_LAN="nas=192.168.1.5:445,printer=192.168.1.20:9100"`.
With `HUB_HA_URL` and `HUB_HA_TOKEN` it also reports a Home Assistant in that network (and the remote view
uses that address; `HUB_PRO_UI=0` turns the view off, `HUB_PRO_UI_URL` sets another address).

Local checks can also be web addresses (`shop=https://shop.example.com`): the agent reports the HTTP status,
the response time and the days until the TLS certificate expires (a device with its own certificate, such as a NAS
or a printer, counts as working and is marked as not trusted). Every report also carries internet quality
(packet loss and latency to 1.1.1.1, DNS); `HUB_PRO_NET=0` turns that off. With `scan_devices` (add-on) or
`HUB_PRO_DEVICES=1` (Docker) the agent reads the ARP table and tells the installer when a device appears in the
network for the first time; the list is kept in `/data/pro_devices.json`, only MAC and IP addresses.

Without Supervisor (Home Assistant in Docker or Core) the installer can still read the Core log, start a backup
and set a nightly backup (Home Assistant 2025.1 or newer, backups stay on the Home Assistant disk).
