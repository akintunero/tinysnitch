# Tiny Snitch

Know your network. Configure it. Fix it.

An AI-assisted network engineering workbench. It reads your network, finds faults with checks that quote the device
output they rest on, and applies configuration changes only after you approve them, with a snapshot first,
read-back verification and rollback. It works with Cisco Modeling Labs and with real devices over SSH.

The Anthropic API key, the MCP credentials and device credentials stay on the server. They are never sent to the
browser, and they are masked in logs, in the activity feed and before any device output reaches Claude.

## What it does

| Page | What it is for |
|---|---|
| **Networks** | Every network from every source: CML labs, sites in an inventory file, NetBox sites, discovery crawls. Each is marked lab or production. |
| **Topology** | The real devices and links, drawn from the source. Link colours come from what devices reported, never from a guess. |
| **Network Assistant** | Ask in plain language. Claude reads the network through tools and answers from the output. It cannot change a device; it can file a change proposal. |
| **Diagnostics** | Deterministic read-only checks. Every finding quotes device output and is **confirmed** or **suspected**. Claude can explain findings but cannot add any. |
| **Configurations** | Propose, review, approve, apply, verify, roll back. Includes provisioning of new devices. |
| **Activity** | An audit log of everything: reads, proposals, approvals, deployments, errors. |

## Where devices come from

Tiny Snitch is written against two interfaces, so nothing outside `lib/providers` and `lib/transport` knows whether
a network is a lab or real hardware.

- **Inventory provider** says what exists and whether it can be reached.
  - **CML**, through your CML MCP server.
  - **Inventory file** (`TS_INVENTORY_FILE`): sites, devices, optional links, credential references. See `inventory.example.yaml`.
  - **NetBox**: sites, devices (primary IP, platform, role) and cables.
  - **Discovery**: a bounded crawl of CDP/LLDP neighbour tables from seed devices. Real links are derived from neighbour tables.
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

## How changes work

1. **Propose.** A person writes the lines, the assistant calls `propose_change`, or provisioning renders a baseline.
   Validation runs before anything is stored: unknown devices, unsupported platforms, size limits, and **blocked lines**
   (reload, erase, copy, crypto key changes, debug, clear, command chaining, output redirection) are refused outright.
   Lockout-capable lines (users, AAA, VTY lines, removing interfaces or routing, default route, hostname) are marked **high risk**.
2. **Approve.** In *Suggest* mode nothing can be approved. In *Approve and deploy* a person approves, and for production or
   high-risk changes confirms they read every line. *Autopilot* applies only small (30 lines, 3 devices), low-risk changes in
   **lab** networks, and only if "allow configuration changes" is on in Settings. Production is never applied automatically.
3. **Snapshot.** Every device's running configuration is read first. If any device cannot be read, nothing is changed.
   A change that would cut off the address Tiny Snitch manages a device on (shutting or readdressing that interface) is refused.
4. **Apply** device by device. If a device rejects a line, the change is rolled back on every device it touched.
5. **Verify.** Each device is read back and every line must show in the running configuration (on Junos, in `show configuration | display set`).
   On Junos the change is only made permanent after this check passes; if it does not, the device reverts it on its own. Diagnostics are re-run and
   any new problem is listed. A line the device accepted but did not apply is reported as unverified, not as success.
6. **Roll back** at any time. The rollback is computed from a fresh read of the device against the snapshot, limited to the
   sections the change touched, so it is correct even after a partial push and does not revert other people's edits.
7. **Save to startup** is a separate, explicit step.

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

## Diagnostics

For each readable router or switch it runs read-only commands, one per call (`show ip interface brief`,
`show running-config`, OSPF and BGP state, VLAN, trunk and EtherChannel state), plus a short ping between directly
connected up/up neighbours. A device that is stopped or unreachable, or a command that fails, is reported as not inspected
with the reason; nothing is concluded about it.

Checks: administratively or operationally down interfaces, connected routed interfaces with no address, OSPF neighbours missing or
stuck (with the cause when the configuration shows it: area, passive, mask, one-sided, MTU), BGP peers not established,
trunk/access, VLAN and native-VLAN mismatches, EtherChannel member state, failed pings, duplicate IPs and router IDs,
mask and subnet mismatches.

**Not checked** (stated in every run): incorrect next hops, routing loops and missing routes, spanning-tree inconsistencies,
conflicting ACLs, host default gateways, traceroute paths and asymmetric reachability, and devices that are not routers or
switches of a supported platform.

## Checks you can run

```bash
npm test                           # unit, API, SSH and change-workflow tests
npm run typecheck
npm run mcp:inspect -- --probe     # connect to the CML MCP server, list its real tools, run one read-only tool
npm run claude:smoke               # Claude calls a read-only CML tool through the bridge
npm run capture -- <labId> <node>  # save real device output as test fixtures (read-only)
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
- **Verified against an in-process SSH server that behaves like an IOS CLI, not real hardware:** the SSH transport (login,
  prompts, pager, host keys, config mode, error detection), the static inventory provider, discovery crawling, and the whole
  change workflow including rollback after partial failure. Real devices differ in prompts, banners, paging and error text;
  expect to adjust on first contact with your hardware, and start with one non-critical device.
- **Verified against faithful in-process servers, not real devices:** the NETCONF transport (including candidate, commit confirmed,
  confirm and discard), Arista eAPI and Cisco NX-API, each backed by a device model that holds configuration, and the full change
  workflow over each of them. The fakes were written from the vendors' documentation; a real device may differ in message details.
- **Verified only against documented sample output:** the Arista EOS, Cisco NX-OS and Juniper Junos parsers, and CDP/LLDP parsing
  beyond the IOS CDP capture. The NX-API `copy running-config startup-config` save is best-effort and unconfirmed.
- **Verified only against mocked HTTP responses:** the NetBox provider.
- **Not implemented:** RESTCONF, NETCONF for platforms other than Junos, SNMP/telemetry, scheduled runs, multi-user accounts or
  roles (the app is a single-user tool bound to loopback).

## Safety notes

- Credentials never appear in API responses, the activity log or error messages (they are redacted before storage).
- Inventory files hold references to secrets, not secrets; a literal password is rejected on load.
- Device and MCP output is untrusted: it is wrapped as data before Claude sees it, and masked for secrets.
- The read-only command allowlist (`show`, `ping`, `traceroute`; one command per call; no chaining or redirection) is enforced
  inside every transport, so no caller can widen it.
- Configuration lines that erase, reload, copy files, change keys, enable debug or clear state are never sent, whoever approved them.
- `NODE_TLS_REJECT_UNAUTHORIZED=0` in `CML_MCP_ENV` disables certificate checks for the MCP child process only.
- What leaves your network: device output and topology are sent to the Anthropic API when you use the assistant or "Explain findings".
  Secrets are masked first, but configurations and addressing are still sent. Decide whether that is acceptable for production networks.
