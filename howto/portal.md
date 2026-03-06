# How to configure the Awan Saya portal + hub directory

Awan Saya serves two related things:

- the **portal UI** (multi-hub dashboard)
- the **hub directory API** (`GET /api/hubs`) used by the Tela CLI for hub name resolution

The portal server proxies hub status on behalf of the browser. The browser never contacts hubs directly — no CORS headers or browser-to-hub connectivity are required.

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

- `AWANSATU_API_TOKEN` (server-side environment variable)

## Verify portal-to-hub visibility

The portal server proxies hub status. For each hub in the directory, verify that the server can reach the hub:

- From the portal server (or via `curl` from the server host):
  ```bash
  curl -H "Authorization: Bearer <viewerToken>" https://<hub>/api/status
  ```
- Confirm it returns JSON.

Alternatively, check the proxy endpoint from a browser:

- `https://awansaya.net/api/hub-status/<name>`

If this returns an error, the hub is unreachable from the portal server or the viewer token is invalid/missing.
