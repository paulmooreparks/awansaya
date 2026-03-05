# HOWTO — Personal Cloud / Homelab Remote Access (Tela + Awan Satu)

This guide shows how to use Awan Satu as the platform layer for Tela so you can:

- Discover hubs by short name (no copying `wss://...` URLs around)
- Use one portal login for hub name resolution
- View hub/machine status in the portal dashboard

It assumes:

- You already have a reachable Tela Hub URL
- You can run `telad` either on the endpoint machine or on a gateway/bridge

---

## What Awan Satu is doing (today)

- Awan Satu maintains a hub directory (currently configured via `www/portal/config.json`).
- The portal UI fetches each hub’s `/api/status` and `/api/history` directly.
- The `tela` CLI can resolve hub names via Awan Satu’s `/api/hubs` endpoint after `tela login`.

---

## Step 1 — Make your hub reachable

You need a hub URL like:

- `https://owlsnest-hub.example.com` (console + API)

From a browser, verify:

- `https://owlsnest-hub.example.com/` loads
- `https://owlsnest-hub.example.com/api/status` returns JSON

---

## Step 2 — Add your hub to Awan Satu’s directory

Edit the hub directory file:

- [awansatu/www/portal/config.json](../www/portal/config.json)

Add an entry:

```json
{
  "hubs": [
    { "name": "owlsnest", "url": "https://owlsnest-hub.example.com" }
  ]
}
```

Deploy/restart Awan Satu.

Verify the directory API:

- `https://awansatu.net/api/hubs`

---

## Step 3 — (Optional) Require an API token for /api/hubs

Awan Satu supports a simple shared token today.

- If `TELA_API_TOKEN` is **unset**, `/api/hubs` runs in open mode.
- If `TELA_API_TOKEN` is **set**, clients must send `Authorization: Bearer <token>`.

Set it in your deployment environment (example):

```bash
export TELA_API_TOKEN="your-long-random-token"
```

Restart Awan Satu.

---

## Step 4 — Register your home machine(s) with the hub

Use either pattern:

- **Endpoint agent**: run `telad` on the home machine
- **Gateway/bridge agent**: run `telad` on a gateway and set `target:` to the home machine’s LAN IP/hostname

Once registered, the hub console should show machines/services.

---

## Step 5 — Client workflow (hub names via portal login)

On the machine you want to connect *from*:

1. Download `tela` from GitHub Releases.
2. Run:

```bash
tela login https://awansatu.net
```

- If your portal is in open mode, you can press Enter when prompted for a token.
- If your portal enforces `TELA_API_TOKEN`, paste the token.

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

- Confirm `https://awansatu.net/api/hubs` lists the hub.
- Confirm you logged in: `tela login https://awansatu.net`.
- Confirm the hub name matches (case-insensitive match is expected, but keep it consistent).

### Hub appears in Awan Satu but status is failing

- Confirm hub `/api/status` is reachable from your browser.
- Confirm HTTPS and certificate are valid.
- Confirm mixed-content is not blocked (portal is HTTPS; hubs should also be HTTPS).
