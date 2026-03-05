# Networking & reachability

Awan Satu’s Portal is a **multi-hub dashboard**. That means the user’s **browser** must be able to reach each hub directly.

## What must be reachable

For a hub to appear healthy in the portal:

- The browser must be able to fetch the hub’s public endpoints:
  - `GET https://<hub>/api/status`
  - `GET https://<hub>/api/history`
- The hub must allow cross-origin reads of those endpoints (CORS).
  - Product requirement: hubs must send an appropriate `Access-Control-Allow-Origin` for the portal origin.
  - Implementation note: Tela’s current hub implementation uses permissive CORS (`Access-Control-Allow-Origin: *`) for these endpoints.

Browser constraints to keep in mind:

- If the portal is loaded over `https://`, the hub URLs must also be `https://` (mixed content is blocked by browsers).
- If a hub uses a self-signed/untrusted certificate, the portal cannot reliably fetch it.

For the Tela CLI to resolve hub names:

- The CLI must be able to fetch `GET https://awansatu.net/api/hubs` (or your self-hosted equivalent).
- If the Awan Satu server is configured with `TELA_API_TOKEN`, the request must send `Authorization: Bearer <token>`.

## Common failure modes

- Hub works for CLI but portal shows nothing:
  - portal is running in the browser, so it depends on browser → hub reachability (not server → hub)
- Portal lists the hub but cards stay empty:
  - hub `/api/status` or `/api/history` not reachable, or blocked by CORS
- CLI can’t resolve hub names:
  - `/api/hubs` unreachable or token mismatch
