# HOWTO — Education / Lab Environments (Tela + Awan Satu)

This guide shows how to use Awan Satu as the discovery/orchestration layer for multiple lab hubs, making student onboarding simpler.

---

## Step 1 — Deploy one hub per lab/course

Make each hub reachable via HTTPS.

---

## Step 2 — Add hubs to Awan Satu

Update [awansatu/www/portal/config.json](../www/portal/config.json).

Example:

```json
{
  "hubs": [
    { "name": "cs101", "url": "https://cs101-hub.example.com" },
    { "name": "cs201", "url": "https://cs201-hub.example.com" }
  ]
}
```

Deploy/restart Awan Satu.

---

## Step 3 — Register lab machines with `telad`

Prefer endpoint-agent pattern.

Expose RDP/SSH as needed.

---

## Step 4 — Student workflow

```bash
tela login https://awansatu.net

tela machines -hub cs101

tela connect -hub cs101 -machine lab-pc-017
```

---

## Portal workflow

Students can also open:

- `https://awansatu.net/portal/`

to see which machines are online and discover the hub console.
