# HOWTO — IoT / Edge Device Management (Tela + Awan Saya)

This guide shows how to manage fleets of devices across many sites using Tela for transport and Awan Saya for hub discovery and aggregation.

---

## Step 0 — Model your fleet

Two common models:

- **Hub per site/customer** (recommended isolation)
- **Hub per fleet segment** (by region, product line, etc.)

Recommendation:

- Hub per site/customer.

---

## Step 1 — Deploy a hub for each site/customer

Each site hub must be reachable via HTTPS.

Verify:

- `/api/status` returns JSON
- WebSockets are supported

---

## Step 2 — Add all hubs to Awan Saya

Update [awansaya/www/portal/config.json](../www/portal/config.json):

```json
{
  "hubs": [
    { "name": "cust-acme", "url": "https://acme-hub.example.com", "viewerToken": "<hub-viewer-token>" },
    { "name": "cust-zen", "url": "https://zen-hub.example.com", "viewerToken": "<hub-viewer-token>" }
  ]
}
```

Deploy/restart Awan Saya.

---

## Step 3 — Register devices

Choose a pattern:

- **Endpoint agent**: `telad` on each device.
- **Gateway/bridge**: `telad` on a site gateway that can reach devices.

Expose SSH (22) and any necessary admin ports.

---

## Step 4 — Technician workflow

On a technician machine:

```bash
tela login https://awansaya.net
```

Then connect by hub name:

```bash
tela machines -hub cust-acme

tela connect -hub cust-acme -machine kiosk-001
```

---

## Troubleshooting

### A hub is online in the portal but devices are missing

- Confirm `telad` is running at that site.
- Confirm device connectivity out to the hub.
