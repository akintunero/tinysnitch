# Tiny Snitch

**Know your network. Configure it. Fix it.**

Tiny Snitch is an AI-assisted workbench for running production networks. It reads your devices, finds faults with checks that quote
the device output they rest on, and changes configuration only after a person approves it: snapshot first, read-back verification
afterwards, rollback if anything is wrong. It manages real devices over SSH, NETCONF and vendor APIs, and can also drive a lab
simulator through an MCP server.

- **Production first.** Every change needs a person's approval, runs canary-first, respects a maintenance window, and may only touch
  devices that have been signed off as ready to go live.
- **You choose the AI model.** Diagnostics, backups, drift and the change workflow need no AI at all. The assistant is optional, and
  what it sees is pseudonymised and stripped of secrets first.
- **Nothing is assumed.** Anything it could not check is reported as "not inspected", never guessed.

**New here? Read the [usage guide](docs/USAGE.md)**: connecting networks, SSH keys, discovery, workflows, securing a deployment,
troubleshooting. This README is the short reference for how each part works.

## What is in it

| Page | Purpose |
|---|---|
| **Networks** | Every network from every source, each marked lab or production. |
| **Topology** | Devices and links from the source. Link colours come from what devices reported. |
| **Network Assistant** | Ask in plain language; it answers from live device output. It cannot change a device, only file a proposal. |
| **Diagnostics** | Read-only checks. Each finding quotes its evidence and is **confirmed** or **suspected**. |
| **Configurations** | Propose, preview, approve, schedule, apply, verify, roll back. |
| **Services** | Catalogue services (VLAN, BGP neighbour, ACL entry...) tracked as instances that follow their change. |
| **Backups** | Versioned configurations, diffs, drift, and the go-live readiness of each device. |
| **Activity** | Audit log of every read, proposal, approval, deployment and error. |

## Quick start (real devices)

Needs Node 22.13+.

```bash
npm install
cp .env.example .env.local            # fill it in
cp inventory.example.yaml inventory.yaml
# .env.local:  TS_INVENTORY_FILE=./inventory.yaml   and   SSH_PASSWORD=...   (the file refers to it as env:SSH_PASSWORD)
npm run build && npm run start        # http://127.0.0.1:3000, loopback only
```

Open **Networks**, pick a site, run **Diagnostics**, then **Back up now** on Backups. Use a read-only account where you can
(privilege 1, or a role with only `show`); Tiny Snitch enforces read-only itself, but a restricted account is the stronger guarantee.
Start with one non-critical device. Old IOS images that only offer SHA-1 key exchange or CBC ciphers need `TS_SSH_LEGACY_ALGORITHMS=1`.

Docker: `docker compose up --build`. The image runs as non-root with no capabilities and a health check. Create an administrator before
exposing it, and never run `docker compose config` against a real `.env.local` (it prints the values).

## Where devices come from

| Source | How |
|---|---|
| **Inventory file** | `TS_INVENTORY_FILE`: sites, devices, links, credential *references* (`env:` / `file:`; a literal password is rejected). SSH keys, jump hosts and host-key pinning supported. |
| **Ansible inventory** | `TS_ANSIBLE_INVENTORY` (YAML, JSON, INI). Each top-level group is a network; passwords and vault values are never read. |
| **NetBox** | Sites, devices and cables. |
| **Discovery** | A capped CDP/LLDP crawl from seed devices, confined to a required `allow` list of address ranges; neighbours outside it are recorded but never logged in to. |
| **MCP server** | A lab simulator through its MCP server. The shipped adapter speaks Cisco CML's tools; other simulators (EVE-NG...) need their own adapter. |

| Transport | Platforms | Notes |
|---|---|---|
| SSH | IOS / IOS-XE (full), NX-OS, EOS | First-use host key remembered, a changed key refused; or pin it. |
| NETCONF | Junos | Candidate, check, **commit confirmed**: an unconfirmed change reverts itself. Over plain SSH Junos is read-only. |
| eAPI / NX-API | Arista / Nexus | JSON over HTTPS with the same safety rules. TLS verified unless `insecureTls: true`. |

Only IOS is fully inspected. EOS and NX-OS cover interfaces, OSPF, BGP and addressing; Junos the same. Anything else is "not inspected".
**RESTCONF is not implemented.**

## How a change works

1. **Propose** (a person, the assistant, a finding's fix, or a service form). Blocked lines (reload, erase, copy, crypto keys, debug,
   clear, chaining, redirection) are refused; lockout-capable lines are marked high risk.
2. **Preview** (optional): which lines would change each device, whether Tiny Snitch would lose its own access.
3. **Approve.** Production and high-risk changes need a person who confirms they read every line, and, with login on, a *different*
   person than the proposer. Autopilot applies only small, low-risk changes in **lab** networks, if enabled. Production is never automatic.
4. **Gate** (production): each device must be *ready to go live* (below). Checked at proposal and again just before applying.
5. **Snapshot** every device first; if any cannot be read, nothing is changed.
6. **Apply** device by device, **canary first** and paused for a person to continue, only inside the maintenance window (an administrator
   can override with a recorded reason). A rejected line rolls back everything the change touched.
7. **Verify** by reading each device back; diagnostics re-run and new problems are listed. A line accepted but not applied is reported as
   unverified, not success.
8. **Roll back** any time, computed from a fresh read against the snapshot, limited to what the change touched. **Save to startup** is a
   separate explicit step.

One change runs per network at a time. Any change can also be downloaded as an Ansible playbook; running it through Ansible does **not** carry the snapshot, verification or rollback above, and the file says so.

### Ready to go live, per device

A production device must be readable, configurable, **backed up within 7 days**, free of unreviewed drift, and **signed off by an
approver** on the Backups page. Labs are never held to it; an administrator can turn the gate off in Settings.

## Services

A service is provisioned from a form, filed as an ordinary change, and remembered as an instance: **pending**, **active** (verified on
the devices), **failed**, **inactive** or **retired**. It can be changed or taken away through a change of its own, with removal written
out per service and platform, never guessed. The Services page marks a service **at risk** when the latest diagnostics run has a
critical or warning finding on an interface it uses, and Diagnostics shows which services each finding hurts. It only knows what was
provisioned through Tiny Snitch.

## Diagnostics, fixes and backups

- **Diagnostics** run read-only commands per device: interfaces, OSPF, IS-IS, BGP (peers, wrong AS, route filters, prefix counts),
  VLAN, trunk and EtherChannel mismatches, duplicate addresses, spanning-tree, static routes, ACLs, and a security baseline (SSH v2,
  Telnet, clear-text passwords, SNMP defaults, NTP, syslog, AAA). Every run states what it did **not** check.
- **Finding to fix.** Where there is exactly one right answer (a wrong BGP AS, one end of a link shut, SSH not v2, HTTP server on,
  Telnet on VTY), the finding shows the lines and **Propose this fix** files an ordinary change. Nothing is applied automatically.
- **Backups and drift.** Versions are stored only when they differ (ignoring timestamps); a difference no Tiny Snitch change explains is
  **drift**. Scheduled backups and diagnostics are read-only. The newest 100 versions per device are kept, masked for secrets.

## The AI model and your data

Use the model you choose: **Anthropic**, or **anything that speaks the OpenAI chat-completions format** (OpenAI, Azure OpenAI, OpenRouter,
vLLM, LM Studio, Ollama), which includes local models that never leave your network. Set `LLM_PROVIDER`, `LLM_MODEL`, `LLM_BASE_URL` and
`LLM_API_KEY` (see `.env.example`). Plain http is accepted only to this machine or a private network. What the model sees is controlled in
Settings, Privacy, and stated on the assistant page:

- **Secrets are always removed.** Device and MCP output is wrapped as untrusted data.
- **Pseudonymised by default for production:** IP and MAC addresses, device and network names, user and domain names, public AS numbers
  and configuration-object names (route-maps, prefix-lists, ACLs, VRFs) become stand-ins, and are put back in what you read. Addresses
  in a subnet stay in that subnet, so the model can still reason about topology. Descriptions, SNMP contacts and banners are removed.
  Add customer or site names under "Words to always hide".
- **The mapping stays in server memory.** Each request is logged in Activity with how much was replaced, never the content.
- **Not guaranteed anonymous:** VLAN IDs, interface names, software versions, route and ACL structure, and unrecognised free text are not
  masked. For stricter control leave the assistant unconfigured; everything else works without it.

## Sign-in, API and webhooks

- **Roles:** viewer (read), operator (diagnostics, backups, propose), approver (approve, apply, roll back, sign off devices), admin
  (settings, users, window override). Passwords use scrypt (12+ characters); sessions are `HttpOnly`, `SameSite=Strict`; five wrong
  passwords lock a name for 15 minutes. A fresh install listening beyond loopback is closed until the first administrator is created
  with a setup token. No SSO, LDAP or two-factor sign-in yet.
- **REST API** at `/api/v1` (OpenAPI at `/api/v1/openapi.json`). Tokens carry a role, can expire and be revoked, are stored hashed, and
  can never manage users, tokens, webhooks or settings. Everything goes through the same approvals and safety rules as the web interface.
  `Idempotency-Key` makes a POST safe to retry.
- **Webhooks** for change, service, diagnostics, finding and drift events, signed with HMAC-SHA256 (`X-TinySnitch-Signature`) and retried
  on a schedule. Destinations are checked: loopback, link-local and metadata addresses are refused, redirects are not followed.
  Put TLS in front of the API: tokens travel in a header.

## Safety rules that cannot be bypassed

- The read-only allow-list (`show`, `ping`, `traceroute`; one command per call; no chaining or redirection) is enforced inside every transport.
- Lines that erase, reload, copy files, change keys, enable debug or clear state are never sent, whoever approved them.
- Credentials never appear in API responses, logs or errors. The app listens on loopback only and rejects cross-origin writes.
- Anything destructive in the interface asks first and is recorded in Activity.

## Configuration

`.env.local`: `LLM_PROVIDER` (`anthropic` or `openai`), `LLM_MODEL`, `LLM_BASE_URL`, `LLM_API_KEY` (the AI model, optional; `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` still work); `TS_INVENTORY_FILE`; `TS_ANSIBLE_INVENTORY`;
`NETBOX_URL`, `NETBOX_TOKEN`, `NETBOX_SSH_*`; `CML_MCP_*` for a CML MCP server (stdio or http). In `CML_MCP_ARGS` write `{{VAR}}`
instead of `${VAR}`: Next.js expands `${VAR}` in `.env` files before the app sees it. Run `npm run dev` for development.

## Checks you can run

```bash
npm test                           # unit, API, SSH and change-workflow tests
npm run typecheck
npm run mcp:inspect -- --probe     # connect to the MCP server, list its tools, run one read-only tool
npm run claude:smoke               # the AI model calls a read-only tool through the bridge
npm run capture -- <labId> <node> [node ...] [--out folder]   # save real device output as test fixtures (read-only)
```

## What has and has not been verified

- **On real devices (CML IOSv, IOSvL2, IOL-XE):** the IOS parsers and checks on captured output; diagnostics end to end; one small
  change applied, verified and rolled back; the IS-IS and BGP checks (including a wrong AS, route filters and prefix counts) on a
  five-router lab built with faults; the service lifecycle through the interface.
- **Against in-process fake devices, not hardware:** SSH (login, prompts, paging, host keys, key login), NETCONF, eAPI and NX-API, and the
  whole change workflow including rollback after a partial failure. The fakes follow vendor documentation; real devices differ.
  **SSH to real hardware is still unproven. Start with one non-critical device.**
- **Unproven on real software:** the NX-OS, EOS and Junos parsers and transports (no images were available); NetBox; the Ansible
  import; the playbook export (checked with `ansible-playbook --syntax-check`, never run against a device).
- **Verified in a real browser, light and dark:** the main pages. Not clicked through: the rejected and failed change screens.
- **Verified by building and running:** the Docker image. `docker compose up` with a real `.env.local` was not run.
- **Not implemented:** Kubernetes, RESTCONF, SNMP/telemetry, SSO, LDAP, two-factor sign-in, multiple replicas, Ansible as the way
  changes are pushed (it would bypass the protections), and MCP adapters beyond CML. The OpenAI-compatible adapter is tested against a fake server, not yet a live provider.
