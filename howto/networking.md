# Networking & reachability

Awan Saya's Portal is a **multi-hub dashboard**. The portal **server** proxies hub status on behalf of the browser - the browser never contacts hubs directly.

## What must be reachable

For a hub to appear healthy in the portal:

- The **portal server** must be able to reach the hub's endpoints:
  - `GET https://<hub>/api/status`
  - `GET https://<hub>/api/history`
- The hub entry in the portal must include a valid **viewer token** so the server can authenticate with the hub.
- No CORS headers are required because the browser does not make cross-origin requests to hubs.

For the Tela CLI to resolve hub names:

- The CLI must be able to fetch `GET https://awansaya.net/api/hubs` (or your self-hosted equivalent).
- If the Awan Saya server is configured with `AWANSATU_API_TOKEN`, the request must send `Authorization: Bearer <token>`.

## Common failure modes

- Hub works for CLI but portal shows nothing:
  - Portal server cannot reach the hub, or viewer token is invalid/missing in `config.json`.
- Portal lists the hub but cards stay empty:
  - Hub `/api/status` or `/api/history` not reachable from the portal server, or viewer token expired/incorrect.
- CLI can't resolve hub names:
  - `/api/hubs` unreachable or token mismatch.
