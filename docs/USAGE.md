# Tiny Snitch: usage guide

This guide is for the person who runs Tiny Snitch day to day: connecting networks, reading findings, making changes safely, and
keeping the whole thing secure. The [README](../README.md) is the reference for how each part works; this is the "how do I do X"
companion. Where something has only been tested against fakes and not real hardware, the guide says so.

**Contents**

1. [Concepts in five minutes](#1-concepts-in-five-minutes)
2. [Install and first start](#2-install-and-first-start)
3. [Connect your networks](#3-connect-your-networks)
4. [Onboard real devices: a worked example](#4-onboard-real-devices-a-worked-example)
5. [A tour of the pages](#5-a-tour-of-the-pages)
6. [Everyday workflows](#6-everyday-workflows)
7. [Settings](#7-settings)
8. [People, roles and securing a deployment](#8-people-roles-and-securing-a-deployment)
9. [The assistant and what leaves your network](#9-the-assistant-and-what-leaves-your-network)
10. [API and webhooks](#10-api-and-webhooks)
11. [Troubleshooting](#11-troubleshooting)
12. [What is proven and what is not](#12-what-is-proven-and-what-is-not)
13. [Command reference](#13-command-reference)

---

## 1. Concepts in five minutes

| Term | Meaning |
|---|---|
| **Network** | A group of devices managed together: a CML lab, a *site* in your inventory file, a NetBox site, an Ansible group or a discovery crawl. Everything in the app works on the network you have selected in the header. |
| **Environment** | Every network is **lab** or **production**. Production changes always need a person's approval, run staged, and respect the maintenance window. |
| **Device** | A router or switch (`ios`, `eos`, `nxos`, `junos`). Tiny Snitch only inspects supported routers and switches; anything else is reported as "not inspected". |
| **Finding** | Something wrong that a deterministic check found, with the device output it rests on. **Confirmed** means the output proves it; **suspected** means it is likely but something could explain it. The AI model can explain findings but cannot add any. |
| **Change** | A set of configuration lines for one or more devices, taken through propose, preview, approve, snapshot, apply, verify, roll back. |
| **Service** | Something you provision from a form (a VLAN, a BGP neighbour, an NTP server). It is remembered as a *service instance* that follows its change, so you can see whether it is really in place, change it or take it away. |
| **Backup** | A stored copy of a device's running configuration. A difference nobody made through Tiny Snitch is **drift**. |

The one rule to remember: **nothing reaches a device except through an approved change.** Reading is always read-only (the
transports only allow `show`, `ping` and `traceroute`), and configuration lines that erase, reload, copy files or change keys
are never sent, whoever approved them.

---

## 2. Install and first start

You need Node **22.13 or newer** (the database uses Node's built-in `node:sqlite`).

```powershell
npm install
Copy-Item .env.example .env.local     # then edit .env.local
npm run build
npm run start                          # http://127.0.0.1:3000
```

`npm run dev` runs the development server instead. After changing code in development, restart it if the page behaves as if
it has old code.

### What goes in `.env.local`

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | The assistant and "Explain findings". Optional: diagnostics, backups, drift and changes work without them. |
| `CML_MCP_*` | Connect to a Cisco Modeling Labs MCP server (stdio or http). Optional. |
| `TS_INVENTORY_FILE` | Path to your inventory file for real devices, for example `./inventory.yaml`. |
| `SSH_PASSWORD`, `SSH_ENABLE`, `SSH_KEY_PASSPHRASE` | Whatever names your inventory references as `env:NAME`. |
| `TS_SSH_LEGACY_ALGORITHMS=1` | Allow old SHA-1 key exchange and CBC ciphers for old IOS images. Off by default because it weakens the connection. |
| `TS_ANSIBLE_INVENTORY`, `TS_ANSIBLE_PASSWORD` | Import an existing Ansible inventory. |
| `NETBOX_URL`, `NETBOX_TOKEN`, `NETBOX_SSH_*` | Use NetBox as the source of truth. |
| `APP_PORT`, `APP_HOST` | Where the app listens. Keep `APP_HOST=127.0.0.1` unless you know why not. |
| `TS_SETUP_TOKEN` | Needed to create the first administrator when the app listens beyond this machine. |
| `DATABASE_URL` | The SQLite file, default `file:./data/tiny-snitch.db`. |

`.env.local` is gitignored and is never sent to the browser. Treat it as a credential file.

### Docker

```powershell
docker compose up --build              # http://localhost:3000
```

The image runs as a non-root user with every capability dropped and keeps its database in a volume. Compose publishes the port to
`127.0.0.1` only. Do not change that to `0.0.0.0`, and do not put it behind a public proxy. A container that listens beyond
loopback is **closed until the first administrator exists**: create one with the setup token (`TS_SETUP_TOKEN`, or the one printed
in the server log at start-up). Do not run `docker compose config` with a real `.env.local`: it prints the expanded secrets.

### First sign-in

On a fresh install that listens only on this machine, login is **off**. Turn it on in **Settings → People** by creating the first
administrator (12+ character password). From then on everyone signs in, and the Activity log names the person for every action.

---

## 3. Connect your networks

A network source is whatever tells Tiny Snitch what devices exist and how to reach them. You can use several at once.

### 3.1 Cisco Modeling Labs

Set the `CML_MCP_*` variables and Tiny Snitch lists your labs as networks (marked lab). The CML MCP server must provide a command
tool, or devices cannot be inspected. Check **Settings → Connections** for the connection status and the tools it found.

### 3.2 The inventory file (real devices, recommended)

The inventory is a YAML file listing credentials, optional jump hosts and **sites**. Copy `inventory.example.yaml`, edit it, point
`TS_INVENTORY_FILE` at it, and restart.

```yaml
credentials:
  netops:
    username: netops                    # use a read-only account for monitoring
    privateKey: file:C:/keys/tinysnitch # or: password: env:SSH_PASSWORD
    # passphrase: env:SSH_KEY_PASSPHRASE
    # enablePassword: env:SSH_ENABLE    # only if the login lands at ">" and needs "enable"

jumpHosts:                              # optional bastion
  bastion: { address: 203.0.113.10, credential: netops }

sites:
  - id: hq
    title: Head office
    environment: lab                    # change to production when services go live
    credential: netops
    devices:
      - { name: rtr1, address: 10.0.0.1,  platform: ios, kind: router }
      - { name: sw1,  address: 10.0.0.11, platform: ios, kind: l2switch }
    links:                              # optional; see 3.5
      - { a: rtr1, aInterface: GigabitEthernet0/1, b: sw1, bInterface: GigabitEthernet0/0 }
```

**Rules the file enforces**

- **No secrets in the file.** A credential says where its secret lives: `env:NAME` (an environment variable) or `file:/path`. A literal
  password is rejected when the file loads.
- A credential needs a `password` or a `privateKey`.
- Every device needs a credential, its own or its site's default, and it must exist.
- Device `kind` is `router`, `l2switch`, `l3switch` (or `firewall`, `server`, `host`, `other`, which are not inspected).
- `platform` is `ios`, `eos`, `nxos` or `junos`.
- Device names are unique within a site. A link's ends must be devices in the same site.

**Per-device options**

| Option | Use |
|---|---|
| `credential` | Override the site's default. |
| `port` | SSH port if it is not 22. |
| `jump` | Reach the device through a named jump host. |
| `hostKey: "SHA256:..."` | Pin the device's SSH key. Without it the first key seen is remembered, and any later change is refused. |
| `transport` | `ssh` (default), `netconf` (Junos), `eapi` (Arista), `nxapi` (Cisco NX-OS). API transports need a credential with a password reference. |
| `insecureTls: true` | Accept a self-signed certificate on eAPI/NX-API. An explicit risk. |

To get a device's key fingerprint for pinning: `ssh-keyscan -t ed25519 <address> | ssh-keygen -lf -`.

### 3.3 SSH keys instead of passwords

Keys are the better choice: there is no password to leak, and one key can serve every device.

```powershell
ssh-keygen -t ed25519 -f C:\keys\tinysnitch -C "tiny-snitch"
icacls C:\keys\tinysnitch /inheritance:r /grant:r "$($env:USERNAME):(R)"
```

Install the public key on each device (IOS shown; check your version supports it):

```
ip ssh pubkey-chain
 username netops
  key-string
   <contents of tinysnitch.pub>
   exit
  exit
```

Test it by hand first: `ssh -i C:\keys\tinysnitch netops@10.0.0.1`. Then use `privateKey: file:C:/keys/tinysnitch` in the
credential, with `passphrase: env:SSH_KEY_PASSPHRASE` if the key has one. The private key file is now the secret: restrict who can
read it and never commit it. Key login is covered by tests against a fake SSH server (plain, passphrase-protected, wrong
passphrase, untrusted key, missing file); it has not yet been tried against real IOS.

### 3.4 Importing an Ansible inventory

Set `TS_ANSIBLE_INVENTORY` to your existing inventory (YAML, JSON or INI). Each top-level group becomes a network; variables inherit
as Ansible's do.

| Ansible variable | Becomes |
|---|---|
| `ansible_host`, `ansible_port` | address, port |
| `ansible_network_os` | platform (hosts without it are skipped, with the reason shown) |
| `ansible_connection` | `network_cli`/`ssh` → SSH, `netconf` → NETCONF, `httpapi` → eAPI or NX-API |
| `ansible_user` | username |
| `ansible_ssh_private_key_file` | key file reference |
| `tiny_snitch_environment` | `lab` or `production` (**production if unset**) |

**Passwords are never read from an Ansible inventory**, including vault values. Use `tiny_snitch_password: env:NAME` or one shared
`TS_ANSIBLE_PASSWORD`. Ansible is never used to push changes from Tiny Snitch, because that would bypass the safety workflow.

### 3.5 Links

Links are optional but valuable. Without them, checks that compare the two ends of a cable (one end shut while the other is up, VLAN
or trunk mismatches, ping tests between neighbours) have nothing to compare. Declare them in the file, or run discovery and copy the
result. Ping tests cover at most 12 links per run.

### 3.6 NetBox

Set `NETBOX_URL` and `NETBOX_TOKEN` to list sites, devices (primary IP, platform, role) and cables. NetBox holds no credentials, so
the SSH login for those devices comes from `NETBOX_SSH_USERNAME` with `NETBOX_SSH_PASSWORD` or `NETBOX_SSH_KEY_FILE`. A site is
production unless it carries the tag `lab`. This provider has only been tested against sample files and mocked responses.

### 3.7 Discovery (crawl from a seed)

Discovery finds devices and links by reading CDP/LLDP neighbour tables, starting from a seed. Because a crawl logs in with **one
credential**, it is confined by an **allow-list**: the crawl only ever logs in to addresses inside the ranges you list.

```yaml
discovery:
  - id: hq-crawl
    title: Head office (discovered)
    environment: lab
    credential: netops
    seeds:
      - { address: 10.0.0.1, platform: ios }
    allow: [10.0.0.0/24]        # required; the seed must be inside it
    maxDevices: 15
    maxDepth: 3
```

- `allow` is **required**. Entries are IPv4 addresses or ranges such as `10.0.0.0/16`. Ranges wider than `/8`, hostnames, IPv6 and
  malformed entries are refused when the file loads, and so is a seed outside the list.
- A neighbour outside the allow-list is recorded as *seen* and **never logged in to**; the run's warnings name what was left alone
  (for example an ISP edge or a partner's router).
- A neighbour that advertises no management address, or is not a router or switch, is recorded but not followed.
- Only devices that run CDP or LLDP are found. All devices must accept the same credential.
- `maxDevices` (up to 200) and `maxDepth` (up to 8) bound the crawl further.

**Recommended pattern:** run a crawl once to see what is there, check it against what you expect, then copy the devices and links you
want into a normal site. A fixed list is exact; a crawl can change from one run to the next.

---

## 4. Onboard real devices: a worked example

Suppose you have **5 routers and 10 switches** in one network and want them managed before any services go live on them.

1. **Prepare access.** Create a read-only account on every device (privilege 1 or a role with only `show`). Install the public key
   (section 3.3). If you can, use AAA/TACACS command authorisation on the device as well: Tiny Snitch enforces read-only itself, but a
   restricted account is the stronger guarantee.
2. **Write the inventory.** One site, 15 devices, `kind: router` for the routers and `kind: l2switch` (or `l3switch`) for the
   switches, `environment: lab` while you build. Add links, or crawl once with an allow-list and copy them.
3. **Start small.** Put two or three non-critical devices in first.
4. **Restart and select the network.** Set `TS_INVENTORY_FILE`, restart the app, choose the site in the header.
5. **Run Diagnostics.** Every device should show *inspected*. A device that does not shows a reason; fix credentials, a changed host
   key or an old image (`TS_SSH_LEGACY_ALGORITHMS=1`) before going further.
6. **Take a baseline.** On **Backups**, back up every device. Later differences show as drift.
7. **Clear the foundations.** Work through critical findings first (interfaces, adjacencies, BGP/IS-IS, route filters), then hygiene
   findings (SSH version, HTTP server, Telnet, SNMP, NTP, syslog).
8. **Roll out the common base as services.** Hostname/domain, NTP, syslog, DNS, SNMP location and contact, management hardening.
   Tick all devices for a value that is the same everywhere (NTP, syslog); use one device at a time for values that differ per device
   (hostname, interface addresses). There is no per-device value inside a single service yet.
9. **Try one harmless change first** (an interface description) and watch the full cycle: approve, snapshot, verify, roll back.
10. **Go live.** Add the remaining devices, run Diagnostics and a backup again, then change the site to `environment: production`.
    From then on every change needs approval, runs staged (canary first) and respects the maintenance window. Each device must also be
    **ready to go live** (section 6.6): back it up, review any drift, and have an approver sign it off on the Backups page.

Diagnostics and backups read **every device in the network at once** (three devices at a time). Changes only ever touch the devices
you choose.

---

## 5. A tour of the pages

| Page | What it does |
|---|---|
| **Overview** | Where things stand across the selected network. |
| **Networks** | Every network from every source, with environment, size and state. Select one here or in the header. |
| **Topology** | Devices and links drawn from the source. Link colours come from what the devices reported, never from a guess. |
| **Assistant** | Ask in plain language. The AI model reads the network through read-only tools and answers from the output. It can file a change *proposal*; it cannot apply anything. |
| **Services** | Provision services from a form, see which are in place, change or take them away, and open "Running on the devices" for a per-device summary of what each configuration runs. |
| **Configurations** | The change workflow: propose, preview, approve, schedule, apply, verify, roll back. Also has *Provision new devices* and *Clear finished*. |
| **Diagnostics** | Read-only checks, a history chart and an "Explain findings" button. Each finding has evidence, a probable cause and sometimes a proposed fix. |
| **Backups** | Versions, diffs and drift per device; a schedule for backups and diagnostics. |
| **Activity** | The audit log of everything: reads, proposals, approvals, deployments, errors. |
| **Settings** | Connections, Changes, Privacy, People, API (section 7). |

---

## 6. Everyday workflows

### 6.1 Diagnose

1. **Diagnostics → Run diagnostics.** Leave "Include ping tests" on unless it is too slow.
2. Open a finding to see its evidence (quoted device output), severity and status.
3. A device that could not be read is listed with the reason. Nothing is concluded about it.
4. The run states what it does **not** check (routing loops, missing dynamic routes, ACL behaviour beyond a few cases, spanning-tree
   design, host gateways, traceroute paths, unsupported devices). Silence is not a clean bill of health for those.

**Checks include:** interfaces down or without addresses; OSPF neighbours missing or stuck (with the cause when the configuration
shows it); BGP peers not established, a peer set to the wrong AS, inbound prefix-lists that block some of the prefixes a neighbour's AS
originates (and whether the received count equals expected minus denied), undefined prefix-lists or route-maps, unexplained prefix
shortfalls (reported as *suspected*), and list names that mislead; IS-IS neighbours not UP and links where both ends run IS-IS but
neither sees the other; VLAN, trunk, native-VLAN and EtherChannel problems; duplicate IPs and router IDs; mask mismatches; static routes
with a bad next hop; ACL entries that can never match; spanning-tree inconsistencies; and a security baseline (SSH v2, Telnet, clear-text
passwords, default SNMP communities, HTTP server, NTP, syslog, AAA). The baseline defaults to production networks only; change it in
Settings.

### 6.2 From a finding to a fix

A few findings have exactly one correct answer (a BGP peer set to the wrong AS, an interface shut at one end of a link, SSH not pinned
to v2, the HTTP server enabled, Telnet allowed on VTY lines). For those the finding shows the lines that would clear it, and
**Propose this fix** files them as an ordinary change. Nothing is applied from there: a person approves and applies it. Everything
else gets no fix on purpose, because the right answer depends on a choice only a person can make. There is no automatic proposing in
Autopilot mode.

### 6.3 Make a change

1. **Configurations → New change.** Give it a title, choose a device, write the lines without `configure terminal` or `end`. You can
   add several devices. **Check and file proposal** validates it and stores it; nothing is sent.
   - **Blocked lines** (reload, erase, copy, crypto key changes, debug, clear, command chaining, output redirection) are refused outright.
   - **High-risk lines** (users, AAA, VTY lines, removing interfaces or routing, default routes, hostname) are allowed but marked, and
     need an extra confirmation.
2. **Preview against the devices** (optional). Reads each device now and shows which lines would change it and which are already
   there. It warns when a change would cut off Tiny Snitch's own management access. It changes nothing.
3. **Approve.** In *Suggest* mode nothing can be approved. In *Approve and deploy* a person approves; for production or high-risk
   changes they confirm they read every line. With login on, the person who proposed a production change cannot approve it (unless
   no other approver exists; that is allowed and recorded).
4. **Apply.** The app first snapshots every device; if any cannot be read, nothing changes. It applies device by device. If a device
   rejects a line, the change is rolled back on every device it touched.
   - **Staged rollout (production, several devices):** the first device (the canary) is applied and verified, then the change
     **pauses** so a person can check it and continue or roll back.
   - **Maintenance window (production):** applied only inside the window set in Settings. An administrator can apply outside it with a
     reason, which is recorded.
   - **Schedule** applies it at a time you choose.
5. **Verify.** Each device is read back and every line must appear in the running configuration. A line a device accepted but did not
   apply is reported as *unverified*, not as success. Diagnostics re-run and any new problem is listed.
6. **Roll back** at any time. The rollback is computed from a fresh read against the snapshot, limited to the sections the change
   touched, so it is correct after a partial push and does not revert other people's edits.
7. **Save to startup** is a separate, explicit step. Nothing is saved to startup automatically.

One change runs per network at a time. A change interrupted by a restart is marked failed rather than shown as running. Any change
can be exported with **Download as Ansible playbook**; running it through Ansible does *not* carry Tiny Snitch's protections, and the
file says so at the top.

### 6.4 Provision a service

1. **Services → New service.** Pick the service (VLAN, access or trunk port, port channel, MTU, routed interface, SVI, static route,
   OSPF, BGP neighbour, loopback, OSPF router ID, VRF, NTP, syslog, DNS, hostname, SNMP location/contact, DHCP relay, interface
   description and state, ACL entry, apply an ACL, management hardening, HSRP/VRRP), name it, fill in the fields, choose the devices.
2. **Preview configuration** shows the exact lines each device would get, per platform. Filing it creates the instance **and** an
   ordinary change; approval, snapshot, verification and rollback all apply.
3. The service follows its change:

| Status | Meaning |
|---|---|
| pending | A change is open (proposed, approved or applying). |
| active | The last change was verified on the devices. |
| failed | A change failed or could not be undone; the devices may be partly configured. Retry, take it away or stop tracking it. |
| inactive | It was never applied (the change was rejected or rolled back). |
| retired | It was taken away and that was verified. |

4. **Change** a service (only while active): the page shows what would be removed and what would be added. Changing a field that makes
   it *that* service (the VLAN ID, the interface) removes the old one and provisions the new one in a single change; changing anything
   else overwrites in place.
5. **Take away** files a removal change written out per service and platform, never guessed by negating lines. Some effects are not
   undone automatically (a hostname, a VRF, hardening steps, an OSPF router ID); the page says why.
6. **Stop tracking** forgets the record and sends nothing to any device.

The list of provisioned services has **search, filters (status, type, device, at-risk) and sorting** (recently changed, name, status
with problems first, type). A service is marked **at risk** when the latest diagnostics run has a critical or warning finding on an
interface it uses; each Diagnostics finding shows which services it hurts.

**Running on the devices** (collapsed at the bottom of the Services page) lists, per device, what its latest *saved* configuration says
it runs: BGP, OSPF, IS-IS, static routes, VRFs, VLANs, VLAN interfaces, port channels, loopbacks, gateway redundancy, DHCP relay, NTP,
syslog, DNS, SNMP, access lists and SSH. It reads the stored backups, not the devices, so it is instant and touches nothing. Take a
backup first for a device to appear. It says what is configured, not that it works; Diagnostics checks that. Junos set-format
configurations are not read.

### 6.5 Back up and watch for drift

- **Backups → Back up now**, or switch on scheduled backups and diagnostics (the two selects at the top of the Backups page). Each device's configuration is stored as a new
  version only when it differs from the last, ignoring timestamps and other lines a device rewrites by itself. A version is also kept
  before and after every change and rollback.
- A difference that none of those explains is **drift**. It is listed with how many lines changed, and names a change that failed or
  never finished if it was touching that device.
- Versions are masked for secrets before storage; the newest 100 per device are kept. Deleting a stored version asks first.

### 6.6 Ready to go live, device by device

On a **production** network a device may only be changed once it is ready. The **Ready to go live** panel on the Backups page checks each
device on its own:

| Check | Passes when |
|---|---|
| Tiny Snitch can read it | the connection and credentials work right now |
| Tiny Snitch can configure it | its platform and transport support configuration changes |
| Has a recent backup | the last stored configuration is at most 7 days old (rollback goes back to it) |
| No unreviewed changes made outside Tiny Snitch | no unacknowledged drift for the device |
| A person has signed it off | an approver clicked **Sign off as ready** |

An approver can sign a device off only when the other four checks pass, and can withdraw the sign-off at any time. A change that touches
a device that is not ready is **refused when it is proposed, and checked again when it is applied**, so a device that drifts or loses
its sign-off in between stops the change before anything is touched. Labs are never held to it, and an administrator can switch the gate
off under Settings, Changes. Sign-offs and withdrawals are recorded in Activity.

---

## 7. Settings

| Tab | What is there |
|---|---|
| **Connections** | Status of the AI model connection, CML, the inventory file, Ansible, discovery and NetBox, with the last error. |
| **Changes** | Default execution mode (Suggest, Approve and deploy, Autopilot), "Let Autopilot apply configuration changes", the maintenance window, and whether the compliance checks run on all networks, only production or none. (The backup and diagnostics schedules are on the Backups page.) |
| **Privacy** | "Hide identifying data from the AI model" (production only, all networks or off), "Words to always hide from the AI model" and "Words that are safe to show the AI model". |
| **People** | Turn login on, create users, set roles, reset passwords, disable users. |
| **API** | Create and revoke API tokens, manage webhooks, view delivery logs, link to the OpenAPI document. |

**Execution modes:** *Suggest* drafts and validates changes but nothing can be approved. *Approve and deploy* lets a person approve and
apply. *Autopilot* applies only small (30 lines, 3 devices), low-risk changes in **lab** networks, and only if allowing configuration
changes is switched on. Production is never applied automatically.

---

## 8. People, roles and securing a deployment

| Role | Can |
|---|---|
| viewer | Look at everything (topology, findings, backups, activity). |
| operator | Also run diagnostics and backups, use the assistant, propose changes. |
| approver | Also approve, apply, schedule, continue and roll back changes. |
| admin | Also manage settings and users, and apply outside a maintenance window. |

Passwords are hashed with scrypt and must be 12+ characters. Sessions are an `HttpOnly`, `SameSite=Strict` cookie that ends after 8
hours idle or 7 days, or when the user is disabled or their password or role changes. Five wrong passwords lock a name for 15 minutes.
There is no SSO, LDAP or two-factor sign-in, and it is one instance with in-process state, so it is not designed for several replicas.

### Security checklist for real devices

1. **Dedicated, least-privilege device accounts.** Read-only for monitoring; a separate account for changes only if you need one. Use
   AAA/TACACS command authorisation on the device where you can.
2. **SSH keys** rather than passwords (3.3). Lock down the key file. Use a dedicated key for this app.
3. **Pin host keys** (`hostKey:`) for every device. A changed key is refused, not replaced.
4. **Discovery allow-list** on every crawl (3.7), and prefer a fixed inventory for normal operation.
5. **Protect `.env.local`, the inventory file and the database** (`data/`): file permissions, encrypted disks, no shared copies. The
   database holds backups (masked for secrets, but they reveal topology) and webhook signing secrets in the clear.
6. **Put TLS in front of the app** (a reverse proxy) before anyone reaches it over a network. The app has no TLS of its own, and API
   tokens travel in a header.
7. **Turn login on** and give each person the least role they need. Keep approvers separate from proposers for production.
8. **Mark production as production.** That forces approvals, staging and the maintenance window.
9. **Rotate any secret that was ever printed or committed.** Check git history before publishing the repository.
10. **Decide what the assistant may see** (section 9). Leave it unconfigured for the strictest control.

Not available yet: a secrets vault (secrets are env variables or files), built-in HTTPS, SSO/LDAP, two-factor sign-in.

---

## 9. The assistant and what leaves your network

The assistant and "Explain findings" send device output and topology to the AI model provider you configure (today the Anthropic API). Secrets are always masked first. By
default, for production networks, **identifying data is masked too**: IP and MAC addresses, device and network names, user and domain
names are replaced with stand-ins before the request and put back in what you read. Addresses in one subnet stay in one subnet, so
The model can still reason about adjacency. Object names (route-maps, prefix-lists, ACLs, VRFs) are split into words, generic purpose words
stay, and the rest are replaced. Interface descriptions, SNMP location/contact and banners are removed outright.

Masking is a strong reduction in what is exposed, not a guarantee of anonymity: VLAN IDs, interface names, versions, route and ACL
structure, and identifying text in places it does not recognise are not masked. Add customer or site names to "Words to always hide".
Diagnostics, backups, drift and the change workflow do not use an AI model at all, so leaving the assistant unconfigured is a fully
supported mode.

The assistant page says, above the message box, whether the selected network is being pseudonymised, and warns in amber when it is not.
The real-to-stand-in mapping is held in the server's memory only and is never sent anywhere.

The assistant cannot change a device. It can file a change *proposal*, which a person still approves.

---

## 10. API and webhooks

The REST API lives at `/api/v1` and is described in OpenAPI at `/api/v1/openapi.json`. Everything an API caller does goes through the
same roles, approvals, safety rules, snapshots, verification, rollback and audit as the interface: a script can propose a change but
cannot skip a person's approval.

- **Tokens:** created by an administrator in Settings → API, with a role and optional expiry; shown once, stored hashed, revocable.
  Send `Authorization: Bearer tsk_...`. A token can never manage users, tokens, webhooks or settings. 300 requests a minute each.
- **Idempotency:** a POST with an `Idempotency-Key` can be retried safely.
- **Webhooks:** signed (`X-TinySnitch-Signature: t=<unix>,v1=<hmac>`, HMAC-SHA256 of `<t>.<raw body>`), retried after 1 minute, 5
  minutes, 30 minutes, 2 hours and 6 hours. Events cover changes, services, diagnostics, findings and drift. Events never carry
  configuration lines. Where a webhook may point is checked when saved and again at each connection.
- To call the API from another machine the server must listen beyond this one, which also closes the app until an administrator
  exists. Put TLS in front of it.

```powershell
curl -H "Authorization: Bearer $env:TS_TOKEN" http://tinysnitch.example:3000/api/v1/networks
```

See the README for the full list of events, the signature check and what is not provided.

---

## 11. Troubleshooting

| Symptom | Likely cause and what to do |
|---|---|
| A device shows *not inspected*, "Every command failed" | Read the reason. Wrong credential or key, device unreachable, an old image (try `TS_SSH_LEGACY_ALGORITHMS=1`), a login that lands at `>` (add `enablePassword`), or AAA prompts on login. |
| "login was refused" | The device rejected the key or password. Test by hand with `ssh`. For keys, check the public key is installed and the account allows key login. |
| "the SSH host key changed … Refusing to connect" | By design. Check the device was really replaced or re-keyed. If so, remove its row from the `known_hosts` table of the SQLite database (`data/tiny-snitch.db`); the row's `id` is `address:port`, for example `10.0.0.1:22`. There is no button for this. Then pin the new key with `hostKey:`. |
| Inventory error on start-up, naming a path like `discovery.0.allow` | The file failed validation. The message names the place. Common ones: a literal password, a missing credential, a seed outside `allow`, a range wider than `/8`. |
| My network does not appear | Check `TS_INVENTORY_FILE` is set and points at the file, that the app was restarted, and **Settings → Connections** for the inventory's status. |
| "The lab MCP connection needs attention" | Check **Settings → Connections**. After restarting the dev server it can take a few seconds to reconnect; reload the page. |
| New code does not seem to take effect (development) | Restart `npm run dev`; the dev server can keep an old module loaded. Do not restart while a change is applying. |
| No devices in the service form | The form lists the network's routers and switches from its topology. Check the network is selected and loaded. |
| "Running on the devices" is empty | No backup has been saved for this network yet. Take one on the Backups page. |
| 401 or 403 from the API | Missing or revoked token, or a role too low. A token can never use user, token, webhook or settings routes. |
| 429 from the API | Over 300 requests a minute for that token; see `Retry-After`. |
| Container will not accept sign-up | A container listening beyond loopback needs the setup token (`TS_SETUP_TOKEN`, or the one in the log). |
| `docker compose config` printed my secrets | It expands `.env.local`. Rotate those secrets and do not run it again with real values. |

---

## 12. What is proven and what is not

Stated plainly, so nothing is assumed. The README's verification section is the full list; the short version:

- **Proven on real devices:** IOS parsers and checks on output captured from real IOSv, IOSvL2 and IOL-XE nodes in CML; the change
  workflow end to end on a live CML node; the service lifecycle for one service (a loopback) on a live lab; IS-IS, BGP, route-filter
  and prefix-count checks on captured IOL-XE output and a live lab.
- **Proven only against fakes:** SSH to real hardware (tested against an in-process server that behaves like an IOS CLI, including key
  and passphrase login), discovery crawling, NETCONF, Arista eAPI, Cisco NX-API, and the NX-OS, EOS and Junos parsers. Real devices
  differ in prompts, banners, paging and error text. **Expect to adjust on first contact, start with one non-critical device, and use a
  read-only account for the first run.**
- **Proven only against samples or mocks:** NetBox, the Ansible inventory import and the playbook export (not run by Ansible).
- **Not built:** SSO, LDAP, two-factor sign-in, built-in TLS, a secrets vault, Kubernetes, RESTCONF, SNMP/telemetry, per-device values
  inside one service, automatic fix proposals in Autopilot, and a per-device "ready to go live" gate.

---

## 13. Command reference

```powershell
npm run build                     # production build
npm run start                     # run it (http://127.0.0.1:3000)
npm run dev                       # development server
npm test                          # unit, API, SSH and change-workflow tests
npm run typecheck
npm run mcp:inspect -- --probe    # connect to the lab MCP server, list its tools, run one read-only tool
npm run claude:smoke              # Claude calls a read-only CML tool through the bridge
npm run capture -- <labId> <node> [node ...] [--out folder]   # save real device output as test fixtures (read-only)
docker compose up --build         # run in a container
```
