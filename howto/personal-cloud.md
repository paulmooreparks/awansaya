# HOWTO — Personal Cloud / Homelab Remote Access (Tela + Awan Saya)

This guide shows how to use Awan Saya as the platform layer for Tela so you can:

- Discover hubs by short name (no copying `wss://...` URLs around)
- Use one `tela remote add` for hub name resolution
- View hub/machine status in the portal dashboard

It assumes:

- You already have a reachable Tela Hub URL
- You can run `telad` either on the endpoint machine or on a gateway/bridge

---

## What Awan Saya is doing (today)

- Awan Saya maintains a hub directory (currently configured via `www/portal/config.json`).
- The portal server proxies each hub's `/api/status` and `/api/history` on behalf of the browser, using a stored viewer token per hub.
- The `tela` CLI can resolve hub names via Awan Saya's `/api/hubs` endpoint after `tela remote add`.

---

## Step 1 — Make your hub reachable

You need a hub URL like:

- `https://owlsnest-hub.example.com` (console + API)

From a browser, verify:

- `https://owlsnest-hub.example.com/` loads
- `https://owlsnest-hub.example.com/api/status` returns JSON

---

## Step 2 — Add your hub to Awan Saya’s directory

Edit the hub directory file:

- [awansaya/www/portal/config.json](../www/portal/config.json)

Add an entry:

```json
{
  "hubs": [
    { "name": "owlsnest", "url": "https://owlsnest-hub.example.com", "viewerToken": "<hub-viewer-token>" }
  ]
}
```

The `viewerToken` is a Tela hub token with the `viewer` role. The portal server uses it to proxy hub status; it is never exposed to the browser.

Deploy/restart Awan Saya.

Verify the directory API:

- `https://awansaya.net/api/hubs`

---

## Step 3 — (Optional) Require an API token for hub management

Awan Saya supports a simple shared token today.

- Reading the hub directory (`GET /api/hubs`) is always open — no token needed.
- If `AWANSAYA_API_TOKEN` is **set**, adding/removing hubs (`POST`/`DELETE /api/hubs`) requires `Authorization: Bearer <token>`.
- If `AWANSAYA_API_TOKEN` is **unset**, management is also open.

Create a `.env` file next to `docker-compose.yml` (never commit this file):

```bash
AWANSAYA_API_TOKEN="your-long-random-token"
```

Restart Awan Saya.

---

## Step 4 — Register your home machine(s) with the hub

Use either pattern:

- **Endpoint agent**: run `telad` on the home machine
- **Gateway/bridge agent**: run `telad` on a gateway and set `target:` to the home machine’s LAN IP/hostname

Once registered, the hub console should show machines/services.

---

## Step 5 — Client workflow (hub names via remote)

On the machine you want to connect *from*:

1. Download `tela` from GitHub Releases.
2. Run:

```bash
tela remote add awansaya https://awansaya.net
```

- If your Awan Saya instance enforces `AWANSAYA_API_TOKEN`, paste the token when prompted.
- If it is in open mode, you can press Enter to skip.

3. List machines by hub name:

```bash
tela machines -hub owlsnest
```

4. Connect:

```bash
tela connect -hub owlsnest -machine barn
```

5. Use the service via localhost (SSH/RDP/etc.).

---

## Troubleshooting

### `tela machines -hub owlsnest` says it can’t resolve the hub

- Confirm `https://awansaya.net/api/hubs` lists the hub.
- Confirm you added the remote: `tela remote list`.
- Confirm the hub name matches (case-insensitive match is expected, but keep it consistent).

### Hub appears in Awan Saya but status is failing

- Confirm hub `/api/status` is reachable from the portal server.
- Confirm the viewer token in `config.json` is valid.
- Confirm HTTPS and certificate are valid.
