# Tiny Snitch

Know your network. Configure it. Fix it.

An AI-assisted network engineering workbench. It reads your network, finds faults with checks that quote the device
output they rest on, and applies configuration changes only after you approve them, with a snapshot first,
read-back verification and rollback. It works with Cisco Modeling Labs and with real devices over SSH.

The AI model API key, the MCP credentials and device credentials stay on the server. They are never sent to the
browser, and they are masked in logs, in the activity feed and before any device output reaches the AI model.

**New here? Start with the [usage guide](docs/USAGE.md):** connecting networks and real devices, SSH keys, discovery, everyday
workflows, settings, securing a deployment and troubleshooting. This README is the reference for how each part works.

## What it does

| Page | What it is for |
|---|---|
| **Networks** | Every network from every source: CML labs, sites in an inventory file, NetBox sites, discovery crawls. Each is marked lab or production. |
| **Topology** | The real devices and links, drawn from the source. Link colours come from what devices reported, never from a guess. |
| **Network Assistant** | Ask in plain language. The AI model reads the network through tools and answers from the output. It cannot change a device; it can file a change proposal. |
| **Diagnostics** | Deterministic read-only checks. Every finding quotes device output and is **confirmed** or **suspected**. The AI model can explain findings but cannot add any. |
| **Configurations** | Propose, preview, approve, schedule, apply, verify, roll back. Staged rollout, maintenance windows, provisioning of new devices. |
| **Backups** | Versioned running configurations, diffs, and drift: changes nobody made through Tiny Snitch. Optional schedule. |
| **Activity** | An audit log of everything: reads, proposals, approvals, deployments, errors. |

## Where devices come from

Tiny Snitch is written against two interfaces, so nothing outside `lib/providers` and `lib/transport` knows whether
a network is a lab or real hardware.

- **Inventory provider** says what exists and whether it can be reached.
  - **CML**, through your CML MCP server.
  - **Inventory file** (`TS_INVENTORY_FILE`): sites, devices, optional links, credential references. See `inventory.example.yaml`.
  - **Ansible inventory** (`TS_ANSIBLE_INVENTORY`): YAML, JSON or INI. Each top-level group becomes a network; see below.
  - **NetBox**: sites, devices (primary IP, platform, role) and cables.
  - **Discovery**: a bounded crawl of CDP/LLDP neighbour tables from seed devices, confined to a required `allow` list of address ranges so its one credential is never tried on devices outside them (a neighbour outside is recorded as seen and not logged in to). Real links are derived from neighbour tables.
- **Device transport** talks to devices: `run` for one `show`, `ping` or `traceroute` command, `push` for configuration, `save` to write startup.
  - **SSH** (`ssh2`): per-device credentials, optional jump host, host key pinning or first-use memory with refusal if it later changes.
  - **NETCONF** over SSH (Junos): reads through the `<command>` RPC; changes are loaded into the candidate configuration, checked, and
    committed with **commit confirmed**, so a change that is never confirmed reverts on the device by itself.
  - **Arista eAPI** and **Cisco NX-API**: JSON over HTTPS, with the same CLI lines and the same safety rules as SSH.
  - **CML MCP**: the same operations through the CML server's command tool.

A device names its transport in the inventory (`transport: ssh | netconf | eapi | nxapi`); one network can mix them.
TLS certificates are verified unless a device sets `insecureTls: true`, and plain `http` is accepted only to a loopback address.

| Platform | Inspect | Change | Notes |
|---|---|---|---|
| Cisco IOS / IOS-XE | yes | SSH, CML | Fully supported. |
| Arista EOS | interfaces, OSPF, BGP, addressing | SSH, eAPI | VLAN, trunk and port-channel state not collected. |
| Cisco NX-OS | interfaces, OSPF, BGP, addressing, VLANs | SSH, NX-API | Trunk and port-channel state not collected. |
| Juniper Junos | interfaces, OSPF, BGP, addressing | NETCONF only | Over plain SSH Junos is read-only: its candidate/commit model needs NETCONF. |

Anything else is reported as "not inspected", never half-read. **RESTCONF is not implemented**: it is model-driven (YANG data, not CLI
lines), which does not fit the line-based change workflow here. NETCONF and the vendor APIs above are the supported API routes.
NetBox and discovery reach devices over SSH only.

### Real devices: first run

```bash
cp inventory.example.yaml inventory.yaml     # edit it; secrets stay out of it
# .env.local:
#   TS_INVENTORY_FILE=./inventory.yaml
#   SSH_PASSWORD=...                          # referenced as env:SSH_PASSWORD in the file
npm run build && npm run start
```

Then open **Networks**, select a site, and run **Diagnostics**. Use a read-only account for monitoring where you can
(privilege 1, or a role with only `show`); Tiny Snitch enforces read-only itself, but a read-only account is the
stronger guarantee. Old IOS images that only offer SHA-1 key exchange or CBC ciphers need `TS_SSH_LEGACY_ALGORITHMS=1`,
which is off by default because it weakens the connection.

### Ansible

**Import an inventory you already have.** Set `TS_ANSIBLE_INVENTORY` to an Ansible inventory file (YAML, JSON or INI). Each
top-level group becomes a network; hosts in child groups are included, and variables inherit the way Ansible's do.

| Ansible variable | Becomes |
|---|---|
| `ansible_host`, `ansible_port` | address and port |
| `ansible_network_os` (`cisco.ios.ios`, `nxos`, `eos`, `junos`, ...) | platform |
| `ansible_connection` | `network_cli`/`ssh` → SSH, `netconf` → NETCONF (Junos), `httpapi` → eAPI (EOS) or NX-API (NX-OS) |
| `ansible_user` | username |
| `ansible_ssh_private_key_file` | key file reference |
| `tiny_snitch_environment` (group var) | `lab` or `production`; **production if unset** |
| `tiny_snitch_kind`, `tiny_snitch_links`, `tiny_snitch_host_key` | optional extras |

**Passwords are never read from an inventory.** `ansible_password`, `ansible_ssh_pass`, `ansible_become_password` and vault values
are ignored, and the import says so. Give a password as `tiny_snitch_password: env:NAME` (or `file:/path`), or set
`TS_ANSIBLE_PASSWORD` for all of them. Hosts without `ansible_network_os` (servers, say) are skipped, each with the reason shown on the
network. `ProxyJump`/`ProxyCommand` are not imported, and plain-http `httpapi` is upgraded to https.

**Export a change as a playbook.** Any change has a *Download as Ansible playbook* link. It uses the platform's config module
(`cisco.ios.ios_config`, `cisco.nxos.nxos_config`, `arista.eos.eos_config`, `junipernetworks.junos.junos_config`) with the lines grouped
under their `interface`/`router` parents, and Ansible is told never to save by itself. Running it through Ansible does **not** carry Tiny Snitch's
protections (no snapshot, no read-back verification, no computed rollback), and the file says so at the top. Device names that Ansible would read as
a host pattern (`all`, or containing `:` `,` `!` `&` `*` or spaces) are refused. Ansible is not used to push changes from Tiny Snitch: that would bypass those protections.

## How changes work

1. **Propose.** A person writes the lines, the assistant calls `propose_change`, or provisioning renders a baseline.
   Validation runs before anything is stored: unknown devices, unsupported platforms, size limits, and **blocked lines**
   (reload, erase, copy, crypto key changes, debug, clear, command chaining, output redirection) are refused outright.
   Lockout-capable lines (users, AAA, VTY lines, removing interfaces or routing, default route, hostname) are marked **high risk**.
2. **Preview** (optional). Reads each device now and says which lines would change it and which are already there, flags a change that
   would cut off Tiny Snitch's own access, and on Junos runs the device's own commit check. It changes nothing.
3. **Approve.** In *Suggest* mode nothing can be approved. In *Approve and deploy* a person approves, and for production or
   high-risk changes confirms they read every line. With login on, the person who proposed a production change cannot be the one who approves it
   (as long as another approver exists; if none does, that is allowed and recorded). *Autopilot* applies only small (30 lines, 3 devices), low-risk changes in
   **lab** networks, and only if "allow configuration changes" is on in Settings. Production is never applied automatically.
4. **Snapshot.** Every device's running configuration is read first. If any device cannot be read, nothing is changed.
   A change that would cut off the address Tiny Snitch manages a device on (shutting or readdressing that interface) is refused.
5. **Apply** device by device. If a device rejects a line, the change is rolled back on every device it touched. A production change touching several
   devices is **staged** by default: the first device (the canary) is applied and verified, then the change **pauses** for a person to check it and continue
   (or roll back), so a bad change reaches one device, not all of them. A change can be applied at once, or scheduled for a time.
   **Maintenance window:** a production change is only applied inside the window set in Settings; outside it, an administrator can apply it anyway with
   a reason, which is recorded. Labs are never held to it.
   **Go-live gate:** on production, each device a change touches must be *ready*: readable, configurable, backed up in the last 7 days, free of unreviewed
   drift, and signed off by an approver. The check runs when the change is proposed and again just before it is applied.
6. **Verify.** Each device is read back and every line must show in the running configuration (on Junos, in `show configuration | display set`).
   On Junos the change is only made permanent after this check passes; if it does not, the device reverts it on its own. Diagnostics are re-run and
   any new problem is listed. A line the device accepted but did not apply is reported as unverified, not as success.
7. **Roll back** at any time. The rollback is computed from a fresh read of the device against the snapshot, limited to the
   sections the change touched, so it is correct even after a partial push and does not revert other people's edits.
8. **Save to startup** is a separate, explicit step.

One change runs per network at a time. A change interrupted by a restart is marked failed rather than shown as running.

## Setup

Needs Node 22.13 or newer (the database uses Node's built-in `node:sqlite`).

```bash
npm install
cp .env.example .env.local     # then fill it in
npm run build
npm run start                  # http://127.0.0.1:3000 (loopback only; port from APP_PORT)
```

`npm run dev` runs the development server instead. The app listens on loopback only and rejects cross-origin writes.

### Configuration (`.env.local`)

- `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`.
- CML (optional): `CML_MCP_TRANSPORT=stdio` with `CML_MCP_COMMAND`, `CML_MCP_ARGS`, `CML_MCP_ENV`, or `CML_MCP_TRANSPORT=http` with `CML_MCP_URL`, `CML_MCP_HEADERS`.
- Real devices (optional): `TS_INVENTORY_FILE`, and/or `NETBOX_URL`, `NETBOX_TOKEN`, `NETBOX_SSH_USERNAME` with `NETBOX_SSH_PASSWORD` or `NETBOX_SSH_KEY_FILE`.

**Writing `${VAR}` in `CML_MCP_ARGS`:** Next.js expands `${VAR}` in `.env` files before the app sees it, so a literal
`${CML_AUTH_HEADER}` arrives empty and `mcp-remote` then waits for an interactive sign-in. Write `{{CML_AUTH_HEADER}}`
instead; Tiny Snitch turns it into `${CML_AUTH_HEADER}` when it launches the server.

### Run with Docker

```bash
docker compose up --build        # http://localhost:3000
```

Configuration is read from `.env.local`, the same file as running natively; to use an inventory, uncomment the mount in `compose.yaml`. The image runs
as a non-root user, drops all Linux capabilities, keeps its database in a volume, includes `mcp-remote` (pin it with `MCP_REMOTE_VERSION`) so start-up does not
depend on the npm registry, and has a health check.

**Create an administrator before exposing it to anyone.** Compose publishes the port to `127.0.0.1` only (login is optional there), and a container that listens beyond loopback is closed until the first administrator exists (see Sign-in and roles; set `TS_SETUP_TOKEN` to know the token in advance). Compose publishes the port to `127.0.0.1` only, and the app listens on `0.0.0.0` *inside* the container only because
`APP_HOST` says so (it prints a warning whenever it listens beyond loopback). Do not change the published address to `0.0.0.0`, and do not put it behind a public
proxy or ingress. Secrets stay out of the image and out of `compose.yaml`: use `env:`/`file:` references with environment variables or Docker secrets.

The container must be able to reach your CML server and devices. On Docker Desktop (Windows/macOS) that goes through its NAT and your VPN, so a directly cabled lab
subnet is simpler to reach when you run the app natively. Do not run `docker compose config` with a real `.env.local`: it prints the expanded values.

## Sign-in and roles

Login is **off** on a fresh install that listens only on this machine, as before. Turn it on in Settings (Login and users) by creating the first administrator.
An install that listens beyond this machine (a container, `APP_HOST=0.0.0.0`) is **closed until an administrator exists**, and creating that first one needs a setup token:
`TS_SETUP_TOKEN` if you set it, otherwise the one printed in the server's log at start-up.

| Role | Can |
|---|---|
| viewer | Look at everything (topology, findings, backups, activity). |
| operator | Also run diagnostics and backups, use the assistant, propose changes. |
| approver | Also approve, apply, schedule, continue and roll back changes. |
| admin | Also manage settings and users, and apply outside a maintenance window. |

Passwords are hashed with scrypt and must be 12 or more characters. Sessions are a random token in an `HttpOnly`, `SameSite=Strict` cookie (`Secure` over https); only the token's hash is
stored. A session ends after 8 hours idle or 7 days, and when its user is disabled or their password or role changes. Five wrong passwords lock a name for 15 minutes, and a flood of
failures pauses all sign-ins briefly. The Activity log names the person (`user:alice`). There is no SSO, LDAP or two-factor sign-in, and it is one instance with in-process state, so it is not
designed for several replicas.

## Services

Services in the catalogue (a VLAN, a routed interface, a BGP neighbour, an ACL entry...) are provisioned from a form, and each one is **remembered as a service instance** on the Services
page: what it is, which devices it is on, and whether it is really in place. Filing one creates the instance and an ordinary change for it, so approval, the snapshot, read-back
verification and rollback apply; the service follows that change:

| Status | Meaning |
|---|---|
| pending | A change is open (proposed, approved, applying). |
| active | The last change was verified on the devices. |
| failed | A change failed or could not be undone; the devices may be partly configured. Retry, take it away, or stop tracking it. |
| inactive | It was never applied (the change was rejected or rolled back). |
| retired | It was taken away and that was verified. |

A service can be **changed** (only while active): the page shows what would be removed and what would be put in before anything is filed. Change a field that makes it *that* service (the
VLAN id, the interface) and the old one is removed and the new one provisioned in a single change; change anything else (a description, an MTU) and the new lines overwrite the old. A
service can be **taken away** through a change of its own, with removal written out per service and platform, never guessed by negating lines. Some effects are not undone automatically
(a hostname, a VRF, hardening steps, an OSPF router id); the page says why. **Stop tracking** forgets the record and sends nothing to any device. A modification that is rejected or rolled
back leaves the service as it was, and what is recorded as applied only moves when a change is verified. Clearing an optional field (an empty description) does not unset it on the device.

**Dependencies.** Each service records the devices and interfaces it touches. The Services page marks a service **at risk** when the latest diagnostics run has a critical or warning finding on an
interface it uses (or at the far end of a link from it), and lists what it is affected by; the Diagnostics page shows, on each finding, which services it hurts. A match is either *interface*
(the finding is on an interface the service is bound to) or *device* (the service lives on that device but is not tied to one interface, so it may or may not be affected). A service on one
interface is never marked for a problem on a different interface of the same device. This is only as current as the last diagnostics run, and it joins what was provisioned through Tiny Snitch with
what the devices reported; services configured by hand are not known to it.

Services are also in the API (`/api/v1/services`, and `/api/v1/services/impact` for the dependency view) and raise `service.created`, `service.active`, `service.failed`, `service.inactive` and `service.retired` webhook events.

## API and webhooks

Other systems can read the network and drive changes through a versioned REST API at `/api/v1`, described in OpenAPI at `/api/v1/openapi.json` (also linked from Settings, API).
Everything an API caller does goes through the same roles, approvals, safety rules, snapshots, verification, rollback and audit as the web interface, so a script can propose a
change but cannot skip a person's approval.

**Tokens.** An administrator creates them in Settings, API. A token has a role (viewer, operator, approver, admin), an optional expiry, and can be revoked at once. It is shown once; only
its SHA-256 is stored. Send it as `Authorization: Bearer tsk_...`. A token can never manage users, tokens, webhooks or settings, whatever its role: those need a signed-in person.
Each token is limited to 300 requests a minute (429 with `Retry-After`). The Activity log names what a token did (`user:token:<name>`).

```powershell
curl -H "Authorization: Bearer $env:TS_TOKEN" http://tinysnitch.example:3000/api/v1/networks
curl -X POST -H "Authorization: Bearer $env:TS_TOKEN" -H "Content-Type: application/json" -H "Idempotency-Key: order-4411" `
     -d '{"scopeId":"static:london","title":"Loopback 9","devices":[{"device":"lon-core1","commands":["interface Loopback9"," ip address 10.9.9.9 255.255.255.255"]}]}' `
     http://tinysnitch.example:3000/api/v1/changes
```

A POST that sends an `Idempotency-Key` can be retried safely: the same key and body returns the first answer (`Idempotent-Replay: true`); the same key with a different body is refused (422).

To call it from another machine the server must listen beyond this one (`APP_HOST=0.0.0.0`, as in the Docker setup), which also closes the app until an administrator exists. A call carrying a
token is not subject to the loopback-only Host rule that protects the browser interface; a call without one still is. Put TLS in front of it (a reverse proxy): tokens travel in a header.

**Webhooks.** Tiny Snitch calls a URL when something happens: `change.proposed`, `change.approved`, `change.rejected`, `change.deploying`, `change.paused`, `change.verified`,
`change.failed`, `change.rolling_back`, `change.rolled_back`, `change.rollback_failed`, `service.created`, `service.active`, `service.failed`, `service.inactive`, `service.retired`, `diagnostics.completed`, `finding.opened` and `drift.detected`. Events never carry configuration
lines, and secrets are masked. Each delivery is a POST of `{ id, type, createdAt, data }` with `X-TinySnitch-Event`, `X-TinySnitch-Delivery` and a signature
`X-TinySnitch-Signature: t=<unix seconds>,v1=<hex>`, where `v1` is HMAC-SHA256 of `<t>.<raw body>` with the webhook's secret (shown once). Verify it in constant time and reject an old
timestamp. Any 2xx is success; otherwise the event is retried after 1 minute, 5 minutes, 30 minutes, 2 hours and 6 hours, then marked failed. Settings, API shows each hook's latest result and
its log, and sends a signed test event on request.

Where a webhook may point is checked when it is saved and again when each connection is made: loopback, link-local (which includes cloud metadata addresses), unspecified and multicast
addresses are always refused, redirects are not followed, and a name that resolves to a forbidden address is refused. Private addresses are allowed, because a receiver inside your network is
the normal case; set `TS_WEBHOOK_BLOCK_PRIVATE=1` to refuse them too. `TS_WEBHOOK_ALLOW_LOOPBACK=1` lets a receiver on the same machine through (development only). The signing secret has to be
kept to sign each delivery, so it is stored in the database in the clear; protect the database file like any credential store.

Not provided: OAuth or SSO for API callers, per-network token scopes, delivery ordering guarantees (events can arrive out of order after a retry), exactly-once delivery (use the event `id` to
deduplicate), and idempotency for two identical requests arriving at the same instant.

## Diagnostics

For each readable router or switch it runs read-only commands, one per call (`show ip interface brief`,
`show running-config`, OSPF and BGP state, VLAN, trunk and EtherChannel state), plus a short ping between directly
connected up/up neighbours. A device that is stopped or unreachable, or a command that fails, is reported as not inspected
with the reason; nothing is concluded about it.

Checks: administratively or operationally down interfaces, connected routed interfaces with no address, OSPF neighbours missing or
stuck (with the cause when the configuration shows it: area, passive, mask, one-sided, MTU), BGP peers not established,
trunk/access, VLAN and native-VLAN mismatches, EtherChannel member state, failed pings, duplicate IPs and router IDs,
mask and subnet mismatches. On IOS-style devices also: spanning-tree ports the switch marked inconsistent and linked switches that disagree about a VLAN's root,
static routes whose next hop is outside every connected subnet or behind a down interface, ACL entries that can never match (and duplicates), ACLs applied but not defined, and a small
security baseline (SSH version 2, Telnet on VTY lines, clear-text enable and user passwords, default SNMP communities, the HTTP server, NTP, syslog, AAA). The baseline defaults to
production networks only (it is noise on throwaway labs); change that in Settings. Findings over time are charted from the saved runs.

**Not checked** (stated in every run): routing loops, missing dynamic routes and next hops other than static routes, ACL behaviour beyond the cases above,
spanning-tree design, host default gateways, traceroute paths and asymmetric reachability, and devices that are not routers or
switches of a supported platform.

## From a finding to a fix

A few findings have exactly one correct answer, and for those the check states the lines that would clear it: a BGP neighbour set to the wrong AS (it names the AS the other router really runs),
an interface shut at one end of a link while the other end is up, SSH not pinned to version 2, the HTTP server enabled, and Telnet allowed on the VTY lines. The finding shows those lines and a
note on what to check first, and **Propose this fix** files them as an ordinary change on that device. Nothing is applied from there: a person approves and applies it, with the usual snapshot,
verification and rollback. The finding then shows where each fix stands, a second fix is not filed over an open one, and if a verified fix leaves the finding open the page says so.
Everything else gets no fix on purpose (a mask mismatch, a duplicate address, SNMP or NTP settings), because the right answer depends on a choice only a person can make. There is no automatic
proposing in Autopilot mode. API: `POST /api/v1/findings/{id}/fix`. Not yet tried on a real network's live findings; it is covered by tests and was exercised in the interface on a seeded finding.

## Backups and drift

**Back up now**, or switch a network on for scheduled backups and diagnostics (Settings or the Backups page; read-only; skipped while a change is being applied). Each router's and switch's
running configuration is stored as a new version only when it differs from the last, ignoring timestamps and other lines a device rewrites by itself. A version is also kept before and
after every change and rollback. A difference that none of those explains is **drift**: it is listed with how many lines changed, and a change that failed or never finished is named if it
was touching that device. Versions are masked for secrets before storage; the newest 100 per device are kept.

## Checks you can run

```bash
npm test                           # unit, API, SSH and change-workflow tests
npm run typecheck
npm run mcp:inspect -- --probe     # connect to the CML MCP server, list its real tools, run one read-only tool
npm run claude:smoke               # Claude calls a read-only CML tool through the bridge
npm run capture -- <labId> <node> [node ...] [--out folder]   # save real device output as test fixtures (read-only), one folder per lab
```

## What has and has not been verified

Stated plainly, so nothing is assumed:

- **Verified against real devices:** the IOS parsers and checks, on output captured from running IOSv and IOSvL2 nodes in CML
  (`tests/fixtures/captured`), and diagnostics end to end on a live CML lab.
- **Verified on a live CML node:** the change workflow end to end. A two-line change (a description on an unused, shut-down
  interface of an IOSv router) was approved, snapshotted, applied through CML's multi-line configuration mode, read back and
  confirmed, then rolled back and confirmed against the snapshot. Only that one small change has been run this way: failure
  paths (a device rejecting a line, partial application) are covered by tests against fake devices, not by a real node.
  Nothing was saved to startup.
- **Verified on a real IOL-XE lab (IS-IS plus iBGP/eBGP, built with faults on purpose):** the BGP parser and the check that finds a peer set to the wrong AS, on output captured from all five routers
  (`tests/fixtures/captured-iolxe`). The engine finds that fault and names its cause, with no false findings on interfaces. IS-IS is checked too (below). Route filters and prefix counts are checked as well: an inbound prefix-list that
  denies some of the prefixes a neighbour's AS originates (and whether the received count equals expected minus denied), a prefix-list or route-map that is used but not defined, a received count that falls short
  with nothing in the configuration to explain it (reported as suspected only), and a list named like a block list that only permits. On the captured lab these find Cornwall's filter (8 of 42) and the Paris list name.
- **Verified on the real IOL-XE lab, IS-IS:** the neighbour parser and the interface reader, on `show isis neighbors` and the running configuration captured from all five routers, and a live run on the
  lab (every router answered, no findings, matching adjacencies that are all UP). The two IS-IS checks, a neighbour that is seen but not UP and a link where both ends run `ip router isis` and are up/up
  but neither sees the other (with the circuit-type mismatch named when that is the cause), are tested on written-out output, because the lab has no broken IS-IS adjacency to capture. IOS only for now;
  `show isis neighbors` is asked only of a router whose configuration has `router isis`.
- **Verified on real captured IOS output:** the security baseline and the spanning-tree parser, on configurations and `show spanning-tree` captured from your lab's IOSv and IOSvL2 nodes. The ACL,
  static-route and spanning-tree *checks* are tested on written-out configurations, not captured ones, because the lab's devices have no ACLs, static routes or inconsistent ports to capture.
- **Verified in a real browser:** the sign-in screen, setup, sign-out, wrong-password message and the Settings pages, on an isolated instance. Everything else in the new UI is covered by
  route-level tests, not by clicking through it.
- **Verified on a live CML lab through the interface:** the service lifecycle. A loopback service on an IOSv router was provisioned from the form, approved, applied and verified, changed (a description,
  overwritten in place), then taken away with its own change and retired; the service followed each change by itself. The removal was a high-risk line, which needs the "I have read every line"
  box ticked. The other 24 services, and the rejected, failed and retry paths, are covered by tests only.
- **Verified over real HTTP:** the API (a token from another host, 401 and 403 for a bad token and a role that is too low, a viewer refused a write, a token refused the token-management routes), and
  webhook delivery of a signed test event and of a real diagnostics event to a local receiver. Retry timing runs on a simulated clock in the tests.
- **Verified in a real browser, light and dark:** Overview, Networks, Topology, Diagnostics, Assistant, Configurations, Backups, Activity, Settings (all tabs) and Services. Not clicked through: the
  rejected-change and failed-change screens, and a backup diff in dark mode.
- **Verified by building and running it:** the Docker image (built, runs as a non-root user with every capability dropped, starts closed until the first administrator is created with the setup token, reports healthy,
  accepts an API token from another host, and has no secrets in its environment). Compose was not run with a real `.env.local`.
- **Verified by `ansible-playbook --syntax-check` (ansible-core 2.21, in a container):** an exported playbook for IOS, EOS, NX-OS and Junos devices passes. Nothing was run against a device through Ansible.
  Ansible reports that `junipernetworks.junos` is deprecated in favour of `juniper.device`; the exported Junos tasks still use the old collection for now.
- **Verified against an in-process SSH server that behaves like an IOS CLI, not real hardware:** the SSH transport (login,
  prompts, pager, host keys, config mode, error detection), the static inventory provider, discovery crawling, and the whole
  change workflow including rollback after partial failure. Real devices differ in prompts, banners, paging and error text;
  expect to adjust on first contact with your hardware, and start with one non-critical device.
- **Verified against faithful in-process servers, not real devices:** the NETCONF transport (including candidate, commit confirmed,
  confirm and discard), Arista eAPI and Cisco NX-API, each backed by a device model that holds configuration, and the full change
  workflow over each of them. The fakes were written from the vendors' documentation; a real device may differ in message details.
- **Could not be validated on virtual devices:** this lab's CML has images for IOSv, IOSv-L2, IOL-XE, IOL-L2 and ASAv only. The NX-OSv node type has no image, and there are no Arista or Juniper node
  types, so the NX-OS, EOS and Junos parsers and transports remain unproven against real software. Importing Nexus 9000v, Arista cEOS or vEOS, and Juniper vJunos images into CML would allow it.
- **Verified only against documented sample output:** the Arista EOS, Cisco NX-OS and Juniper Junos parsers, and CDP/LLDP parsing
  beyond the IOS CDP capture. The NX-API `copy running-config startup-config` save is best-effort and unconfirmed.
- **Verified only against sample files and mocked responses:** the NetBox provider; the Ansible inventory import (sample inventories written from Ansible's documented formats, not your own); and the playbook export, whose YAML is checked but which has **not been run by Ansible**.
- **Not run:** `docker compose up` with a real `.env.local`. The Dockerfile and compose file are checked statically (loopback-only port, non-root, no secrets baked in), but the Docker engine was not running when they were written, so `docker compose up --build` has not been tried.
- **Not implemented:** Kubernetes (deployment or management; sign-in exists now, but there is no TLS of its own, no SSO and no multi-replica support, so it would need a TLS-terminating proxy and a single replica), Ansible as the way changes are pushed, RESTCONF, NETCONF for platforms other than Junos, SNMP/telemetry, SSO, LDAP and two-factor sign-in, interface error counters, and a model-provider choice (today the assistant works only with the Anthropic API, though it is meant to accept any model you choose).

## The interface

IBM Plex Sans and Plex Mono are bundled with the app (the `@fontsource` packages), so nothing is fetched at run time. The header has a theme switch (follow the system, light, dark); the choice is a cookie, so
the server renders the right theme from the first byte. Anything destructive asks first and says what will be lost: remove or clear changes (Configurations), delete a stored version (Backups), clear
diagnostics history, delete conversations, and trim the activity log (administrators only; only background reads or entries older than a cut-off, never everything). Each of these is recorded in Activity.

## Safety notes

- Credentials never appear in API responses, the activity log or error messages (they are redacted before storage).
- Inventory files hold references to secrets, not secrets; a literal password is rejected on load.
- Device and MCP output is untrusted: it is wrapped as data before the AI model sees it, and masked for secrets.
- The read-only command allowlist (`show`, `ping`, `traceroute`; one command per call; no chaining or redirection) is enforced
  inside every transport, so no caller can widen it.
- Configuration lines that erase, reload, copy files, change keys, enable debug or clear state are never sent, whoever approved them.
- `NODE_TLS_REJECT_UNAUTHORIZED=0` in `CML_MCP_ENV` disables certificate checks for the MCP child process only.
- What leaves your network: device output and topology are sent to the AI model provider you configure (today that is the Anthropic API) when you use the assistant or "Explain findings".
  Secrets are always masked. By default, for production networks, identifying data is masked too (Settings, "Hide identifying data
  from the AI model"; also available for all networks, or off):
  - IPv4 and IPv6 addresses, device and network names, MAC addresses, user and domain names are replaced with stand-ins before the
    request, and put back in what you read. Addresses in one subnet stay in one subnet and private ranges stay private, so the model can
    still reason about adjacency. The last octet of an IPv4 address is kept (and any longer run of zero bits), so a network address
    stays a valid network address and subnet arithmetic still works; the rest of the address is replaced. Subnet masks, wildcard
    masks, multicast and loopback are left alone as they identify nothing.
  - Names given to configuration objects (route-maps, prefix-lists, ACLs, VRFs, peer-groups, class and policy maps, Junos policies and
    routing instances) are split into words. Generic words that describe a purpose (IN, OUT, GUEST, WIFI, MGMT, UPLINK, PL, V4 and
    similar) stay, so `GUEST-WIFI-IN` is sent as it is and `ACME-BANK-OUT` becomes `obj-3fa91c-OUT`. Any word that is not on the
    built-in list or on your "safe words" list in Settings is treated as identifying and replaced. NTP, syslog and AAA server
    names and public AS numbers are replaced too; private AS numbers are left alone, and a replaced AS number looks like a 32-bit
    private one.
  - Words you list in Settings ("Words to always hide from the AI model") are replaced wherever they occur: customer, site or project names
    that nothing in a configuration declares.
  - Interface descriptions, SNMP location and contact lines, and banners are removed outright.
  - The mapping is kept in this server's memory only. Each request is recorded in Activity with how much was replaced, never the content.
  - Not masked: VLAN IDs, interface names, vendor and software versions, route and ACL structure, and any identifying text in places
    this does not recognise (a customer name inside free text that is not on your list, a device name that no topology, inventory or
    `hostname` line tells the app about). Treat masking as a strong reduction in what is exposed, not a guarantee of anonymity. For
    stricter control, leave the assistant unconfigured: diagnostics, backups, drift and the change workflow do not use an AI model.
  - The setting is read on every request, so switching it mid-conversation takes effect on the next message; earlier messages are
    stored with the real values and masked (or not) as each request is sent.
