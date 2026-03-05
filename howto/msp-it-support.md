# HOWTO — MSP / IT Support (Tela + Awan Satu)

This guide shows how an MSP can use Awan Satu as a multi-customer hub directory and portal, with Tela providing transport to customer machines.

---

## Recommended model

- **One hub per customer** (simplest isolation)
- All customer hubs listed in Awan Satu

---

## Step 1 — Deploy a hub per customer

Each customer hub must be reachable via HTTPS.

---

## Step 2 — Add all customer hubs to Awan Satu

Update [awansatu/www/portal/config.json](../www/portal/config.json) with entries for each customer.

Example:

```json
{
  "hubs": [
    { "name": "acme", "url": "https://acme-hub.example.com" },
    { "name": "zen", "url": "https://zen-hub.example.com" }
  ]
}
```

Deploy/restart Awan Satu.

---

## Step 3 — (Recommended) enforce auth

Set `TELA_API_TOKEN` so that `/api/hubs` requires a token.

---

## Step 4 — Tech workflow

```bash
tela login https://awansatu.net

tela machines -hub acme

tela connect -hub acme -machine ws-01
```

---

## Portal workflow

Open:

- `https://awansatu.net/portal/`

Use it as the tech’s single pane of glass.
