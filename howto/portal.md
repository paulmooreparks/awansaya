# How to configure the Awan Satu portal + hub directory

Awan Satu serves two related things:

- the **portal UI** (multi-hub dashboard)
- the **hub directory API** (`GET /api/hubs`) used by the Tela CLI for hub name resolution

Important detail: the portal UI runs in the **browser** and fetches hub status directly from each hub. Awan Satu does not proxy hub status on behalf of the browser.

## Add / remove hubs

Edit the hub list in:

- `www/portal/config.json`

Implementation note: today the hub directory is file-backed (`config.json`). In a “final product” deployment, this may become a database-backed registry, but the portal + CLI expectations (stable hub name → public hub URL) stay the same.

Typical structure:

```json
{
  "hubs": [
    { "name": "owlsnest", "url": "https://owlsnest-hub.parkscomputing.com" }
  ]
}
```

Notes:

- `name` is the short hub name used by `tela -hub <name>`.
- `url` must be reachable by users’ browsers (the portal fetches hub status directly).
  - If the portal is served over `https://`, hub URLs should also be `https://`.
  - The hub must allow CORS reads for `/api/status` and `/api/history`.

## Verify `/api/hubs`

- In open mode (no token), confirm `GET /api/hubs` returns the JSON directory.
- In token mode, confirm requests include `Authorization: Bearer <token>`.

Token mode is enabled by setting:

- `TELA_API_TOKEN` (server-side environment variable)

## Verify portal-to-hub visibility

For each hub URL in the directory:

- open `https://<hub>/api/status` in a browser
- confirm it returns JSON and includes a permissive CORS header

If you want tighter security than permissive CORS, configure the hub to return `Access-Control-Allow-Origin` for your portal’s origin (for example, `https://awansatu.net`).

If this doesn’t work, the hub will not be visible in the portal regardless of the Awan Satu server health.
