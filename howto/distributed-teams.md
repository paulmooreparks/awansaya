# HOWTO — Distributed Development Teams (Tela + Awan Satu)

This guide shows how to deploy Tela for a distributed team and use Awan Satu for hub discovery and multi-hub visibility.

---

## Step 0 — Choose an environment model

Common options:

- **One hub per environment**: `dev`, `staging`, `prod`.
- **One hub per site**: `office-a`, `office-b`, `cloud`.

Recommendation:

- Start with **one hub per environment**.

---

## Step 1 — Deploy hubs

Deploy a Tela hub for each environment and publish it over HTTPS.

For each hub, verify:

- `/` loads
- `/api/status` works
- WebSockets are supported

---

## Step 2 — Add hubs to Awan Satu

Edit [awansatu/www/portal/config.json](../www/portal/config.json) and list all hubs:

```json
{
  "hubs": [
    { "name": "dev", "url": "https://dev-hub.example.com" },
    { "name": "staging", "url": "https://staging-hub.example.com" },
    { "name": "prod", "url": "https://prod-hub.example.com" }
  ]
}
```

Deploy/restart Awan Satu.

---

## Step 3 — Register machines/services with `telad`

Choose pattern per environment:

- **Endpoint agent** for servers you manage directly (recommended).
- **Gateway/bridge** for networks where endpoints can’t run agents.

Expose only what the team needs (SSH + DB ports, admin HTTP, etc.).

---

## Step 4 — Onboard developers

On a developer machine:

```bash
tela login https://awansatu.net
```

Then connect using hub names:

```bash
tela machines -hub dev

tela connect -hub dev -machine dev-db01
```

---

## Step 5 — Use the portal

Open:

- `https://awansatu.net/portal/`

You should see:

- Which hubs are online
- Which machines are online
- Which services are active

---

## Troubleshooting

### Hub is in config.json but doesn’t appear

- Confirm Awan Satu can serve `config.json` at `/portal/config.json`.
- Confirm the hub URL is reachable from your browser.

### Developers can’t connect by hub name

- Confirm `/api/hubs` returns the directory.
- Confirm `tela login` was run.
