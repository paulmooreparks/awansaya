# HOWTO — Production Service Access (Tela + Awan Saya)

This guide shows how to use Awan Saya to manage hub discovery/access for production hubs, while Tela provides the secure transport.

---

## Step 1 — Deploy production hubs

Common models:

- One prod hub per region (`prod-us-east`, `prod-eu-west`)
- One prod hub per business unit

Ensure each hub is reachable via HTTPS.

---

## Step 2 — Add production hubs to Awan Saya

Update [awansaya/www/portal/config.json](../www/portal/config.json):

```json
{
  "hubs": [
    { "name": "prod-us-east", "url": "https://prod-us-east-hub.example.com", "viewerToken": "<hub-viewer-token>" }
  ]
}
```

Deploy/restart Awan Saya.

---

## Step 3 — Require auth for hub directory (recommended)

Set `AWANSAYA_API_TOKEN` in a `.env` file (never committed) next to `docker-compose.yml`.

The hub directory is always readable. Adding/removing hubs and `tela remote add` require the token.

---

## Step 4 — Deploy `telad` on production machines

Prefer the endpoint-agent pattern for production.

Expose only required ports.

---

## Step 5 — Operator workflow

```bash
tela remote add awansaya https://awansaya.net

tela machines -hub prod-us-east

tela connect -hub prod-us-east -machine prod-web01
```

Use SSH/DB tooling against localhost.

---

## Troubleshooting

### Operators can’t resolve prod hub name

- Confirm `/api/hubs` includes the hub.
- Confirm `tela remote list` shows the remote and token (if required) is correct.
