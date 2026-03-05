# Awan Satu — Use Cases

## Overview

Awan Satu is the platform layer for [Tela](https://github.com/paulmooreparks/tela). Where Tela provides the raw connectivity fabric (outbound-only encrypted tunnels, zero-install client, protocol-agnostic TCP forwarding), Awan Satu adds the orchestration, identity, and multi-hub management that turns Tela from a tool into a service.

**Tela : Awan Satu :: git : GitHub**

You can use Tela standalone, just like you can use git without GitHub. Awan Satu makes it easier to manage at scale.

---

## Deployment Patterns (Tela Works Either Way)

The scenarios below assume one of two common patterns:

### Pattern A: Endpoint Agent (Canonical)

- `telad` runs on each machine you want to access.
- Simplest model: each “machine” in the hub maps to a real host running `telad`.

### Pattern B: Gateway / Bridge Agent

- `telad` runs on a gateway (VM/container/bastion) that can reach one or more target machines.
- Useful when targets are locked down (can’t install agents) or when you prefer to centralize the software footprint.
- Operationally, this is a modern “bastion” pattern: secure when paired with segmentation, allowlists, and strong service auth.

Awan Satu doesn’t require one pattern or the other. It helps teams manage hubs and access consistently regardless of which topology they choose.

---

## What Awan Satu Adds to Tela

| Capability | Tela alone | With Awan Satu |
|------------|-----------|----------------|
| **Hub discovery** | Manual — pass full `wss://` URLs or maintain local `hubs.yaml` | `tela login` once, then use short names like `owlsnest` |
| **Multi-hub view** | Each hub has its own console | Portal aggregates all hubs in one dashboard |
| **Download distribution** | Build from source or manual download | Landing page with OS detection, GitHub Release integration |
| **Identity & access** | Per-hub tokens | Centralized auth, portal-scoped access (SSO/RBAC planned) |
| **Onboarding** | Read docs, configure manually | `tela login https://awansatu.net` → done |

---

## Use Cases

### 1. Personal Cloud / Homelab Remote Access

**Scenario:** You have machines at home (NAS, media server, dev workstation) and want to reach them from anywhere, including locked-down corporate laptops.

**How-to (at a glance):**

- Publish a hub URL (your hub console/API must be reachable).
- Add the hub to Awan Satu’s hub directory.
- On any client machine: download `tela`, run `tela login https://awansatu.net`, then `tela connect -hub <hubName> -machine <machine>`.

Detailed HOWTO: `howto/personal-cloud.md`

**With Tela + Awan Satu:**

- `telad` on your home machines, outbound to your hub. No port forwarding, no dynamic DNS.
- Register the hub on Awan Satu. From any machine: download `tela`, `tela login`, `tela connect -hub myhub -machine nas`.
- The portal shows all your machines and their status across all your hubs.

**Why not alternatives?**

| Solution | Friction |
|----------|----------|
| **Tailscale / ZeroTier** | Requires TUN device. Blocked on managed corporate laptops. |
| **Cloudflare Tunnel** | Awkward for raw TCP (SSH/RDP). |
| **WireGuard (raw)** | Needs admin/root on both ends, port forwarding, manual key management. |
| **tela + Awan Satu** | Zero-install, no-admin client. Hub name resolution via portal. One login, connect by name. |

---

### 2. Distributed Development Teams

**Scenario:** Developers across offices and remote locations need access to shared dev/staging machines (databases, test servers, CI runners).

**How-to (at a glance):**

- Run one hub per environment or site.
- Add all hubs to Awan Satu.
- Onboard users via one portal login; connect by hub name.
- Choose endpoint-agent vs gateway/bridge per environment constraints.

Detailed HOWTO: `howto/distributed-teams.md`

**With Tela + Awan Satu:**

- `telad` on each dev machine, registering outbound to team hubs. IT opens no inbound ports.
- Team lead registers hubs in Awan Satu: "dev", "staging", "prod".
- New developers: `tela login https://company.awansatu.net` → see all available hubs → `tela connect -hub staging -machine db01`.
- **Service-level granularity**: Expose only SSH:22 and Postgres:5432, not the whole network.
- **Contractor access**: Scope a contractor to one hub. Revoke by removing from the portal. No VPN client to uninstall.

**Awan Satu's role:** Centralized hub directory and access control. Without it, each developer needs URLs and tokens for every hub. With it, one login covers everything.

**Why not alternatives?**

| Solution | Friction |
|----------|----------|
| **Teleport** | Heavy — proxy server, `tsh` client, certificate infrastructure. |
| **Tailscale** | Requires TUN/admin per device. Not viable on managed corporate machines. |
| **SSH jump hosts** | SSH-only. Tela tunnels any TCP service. |

---

### 3. IoT / Edge Device Management

**Scenario:** Deploy devices (Raspberry Pi, controllers, kiosks) on customer sites behind NATs and firewalls you don't control. SSH in for maintenance.

**How-to (at a glance):**

- Deploy a hub per customer/site (or per fleet segment).
- Add hubs to Awan Satu so techs can discover them by name.
- Deploy `telad` on devices (or deploy a site gateway `telad`).
- Techs use `tela login` once, then connect by hub name.

Detailed HOWTO: `howto/iot-edge.md`

**With Tela + Awan Satu:**

- `telad` on each device, outbound to a per-customer hub.
- Awan Satu aggregates all customer hubs. One portal shows every device across every site.
- Techs log in to the portal, see status across all deployments, connect to any device by name.

**Awan Satu's role:** Multi-hub aggregation. Each customer site is its own hub; the portal is the single pane of glass. Without it, techs bounce between hub consoles.

**Why not alternatives?**

| Solution | Friction |
|----------|----------|
| **Balena / Particle** | Full IoT platforms. Overkill for remote SSH. |
| **SSH reverse tunnels** | Fragile, no dashboard, manual per-device management. |
| **Tailscale** | Needs TUN on device OS; not always available on embedded Linux. |

---

### 4. Production Service Access (Bastion Replacement)

**Scenario:** A small team runs production services on cloud VMs. Today they SSH through bastion hosts.

**How-to (at a glance):**

- Prefer endpoint-agent `telad` on each production VM.
- Add the production hub(s) to Awan Satu.
- Enforce auth (token now; SSO/RBAC later).
- Operators connect by hub name; rotate access centrally.

Detailed HOWTO: `howto/production-access.md`

**With Tela + Awan Satu:**

- `telad` on each VM, exposing only declared ports.
- Portal provides the team's view of production infrastructure by hub ("us-east", "eu-west").
- Audit trail via hub history.
- WireGuard end-to-end — the hub and portal never see plaintext.

**Awan Satu's role:** Named hub resolution and centralized access management. Decommission a machine or revoke a person's access from one place.

**Why not alternatives?**

| Solution | Friction |
|----------|----------|
| **AWS SSM / GCP IAP** | Vendor-locked to one cloud. |
| **Bastion hosts** | Single point of failure, SSH-only, key management. |
| **HashiCorp Boundary** | Conceptually similar but much heavier to deploy and operate. |

---

### 5. MSP / IT Support

**Scenario:** A managed service provider supports dozens of small businesses, each with a few machines.

**How-to (at a glance):**

- Create one hub per customer (recommended isolation).
- Add all customer hubs to Awan Satu.
- Onboard techs via portal login; connect by hub name.
- Use gateway/bridge when endpoints can’t run agents.

Detailed HOWTO: `howto/msp-it-support.md`

**With Tela + Awan Satu:**

- `telad` on each customer's machines. Each customer can have their own hub.
- Awan Satu aggregates all customer hubs. The MSP tech logs in and sees everything.
- Customer machines are behind NATs. Outbound-only is essential.
- Zero-install client — connect from any machine without installing software.

**Awan Satu's role:** This is the MSP's operational dashboard. Without it, the MSP has a hub console per customer. With it, one portal, one login.

**Why not alternatives?**

| Solution | Friction |
|----------|----------|
| **TeamViewer / AnyDesk** | Per-seat licensing, screen-sharing-focused, privacy concerns. |
| **ConnectWise** | Expensive, vendor-locked, complex. |
| **MeshCentral** | Excellent here. Tela/AS add: cleaner architecture, zero-install client, service-level model, federated multi-hub portal. |

---

### 6. Education / Lab Environments

**Scenario:** A university runs a computer lab. Students access lab machines remotely.

**How-to (at a glance):**

- Run a hub per lab/course and register lab machines.
- Add hubs to Awan Satu so students can discover them by name.
- Students `tela login` and connect to assigned machines.

Detailed HOWTO: `howto/education-labs.md`

**With Tela + Awan Satu:**

- `telad` on each lab machine. Students download `tela`, log in to the school's portal, connect to their assigned machine.
- Portal shows availability and usage across labs.
- No VPN infrastructure. Works through dorm and home networks.

**Awan Satu's role:** Student onboarding. One URL to log into, one place to find available machines.

---

## Where Tela + Awan Satu Are Uniquely Positioned

No existing combination provides all of:

1. **Zero-install, no-admin client** — works on locked-down machines
2. **Protocol-agnostic TCP tunneling** — not just SSH, not just HTTP
3. **Outbound-only agents** — works behind any NAT/firewall
4. **End-to-end WireGuard encryption** — hub and portal never see plaintext
5. **Named hub resolution via portal** — `tela connect -hub owlsnest`, not `wss://10.0.8.14:8443`
6. **Federated multi-hub portal** — one dashboard for many sites, customers, or environments

Tailscale comes closest but requires system-level installation. Cloudflare Tunnel is HTTP-focused. Teleport and Boundary are enterprise-heavy. MeshCentral is screen-sharing-centric. Tela + Awan Satu occupy the gap between "just use SSH" and "deploy an enterprise zero-trust platform," with a clean separation between the connectivity fabric and the management layer.
