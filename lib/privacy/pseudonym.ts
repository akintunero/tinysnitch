/**
 * Replaces the identifying parts of network data (addresses, device and network names, MAC addresses, user and domain
 * names, free-text descriptions) with stand-ins before anything is sent to a language model, and puts the real values
 * back in what comes back. The mapping lives only in memory in this process; it is never sent anywhere.
 *
 * Addresses keep their structure: two addresses in the same subnet get stand-ins in the same subnet, so the model can
 * still reason about adjacency, summarisation and overlap without learning the real addressing. Private ranges stay
 * private-looking. Subnet masks, wildcard masks, multicast and loopback are not identifying and are left alone.
 */
import { createHmac, randomBytes } from "node:crypto";
import { isIPv6 } from "node:net";

export type PseudonymStats = { addresses: number; names: number; macs: number; asns: number; removed: number };

const IPV4 = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d]|\.\d)/g;
const IPV6 = /(?<![\w:.])(?:[0-9a-fA-F]{0,4}:){2,}[0-9a-fA-F]{0,4}(?![\w:.])/g;
const MAC_COLON = /(?<![\w:])[0-9a-fA-F]{2}(?:[:-][0-9a-fA-F]{2}){5}(?![\w:])/g;
const MAC_DOT = /(?<![\w.])[0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\.[0-9a-fA-F]{4}(?![\w.])/g;
// What a stand-in looks like, so restoring only has to look at things of this shape. Six hex digits keep it from
// resembling anything a configuration would really contain.
// A stand-in may sit inside a longer name (GUEST-obj-3fa91c-OUT), so it is bounded by letters and digits, not by hyphens.
const TOKEN = /(?<![A-Za-z0-9_])(?:dev|net|user|obj)-[0-9a-f]{6}(?![A-Za-z0-9_])|(?<![\w.-])domain-[0-9a-f]{6}\.example(?![\w-])/g;
const TOKEN_ANYWHERE = TOKEN;
const ASN_STANDIN = /(?<![\d.])4[2-9]\d{8}(?![\d.])/g;

const NAME = "[A-Za-z0-9][A-Za-z0-9._:-]*";
const LETTER_NAME = "[A-Za-z][A-Za-z0-9._:-]*";
/**
 * Names a person chose for configuration objects, found by the keyword that introduces them. These are where customer
 * and site names usually hide (route-map ACME-BANK-OUT), and nothing in the topology lists them.
 */
const OBJECT_NAMES: RegExp[] = [
  new RegExp(`\\broute-map[ \\t]+(${NAME})`, "g"),
  new RegExp(`\\bprefix-list[ \\t]+(${NAME})`, "g"),
  new RegExp(`\\baccess-list[ \\t]+(?:(?:extended|standard)[ \\t]+)?(${LETTER_NAME})`, "g"),
  new RegExp(`\\baccess-(?:group|class)[ \\t]+(${LETTER_NAME})`, "g"),
  new RegExp(`\\bvrf[ \\t]+(?:(?:definition|forwarding)[ \\t]+)?(${NAME})`, "g"),
  new RegExp(`\\bpeer-group[ \\t]+(${NAME})`, "g"),
  new RegExp(`\\bneighbor[ \\t]+(${LETTER_NAME})[ \\t]+peer-group`, "g"),
  new RegExp(`\\bclass-map[ \\t]+(?:(?:match-any|match-all)[ \\t]+)?(${NAME})`, "g"),
  new RegExp(`\\bpolicy-map[ \\t]+(?:type[ \\t]+\\S+[ \\t]+)?(${NAME})`, "g"),
  new RegExp(`\\bservice-policy[ \\t]+(?:(?:input|output)[ \\t]+)?(${LETTER_NAME})`, "g"),
  new RegExp(`\\bcommunity-list[ \\t]+(?:(?:standard|expanded)[ \\t]+)?(${LETTER_NAME})`, "g"),
  new RegExp(`\\b(?:policy-statement|routing-instances|apply-groups)[ \\t]+(${NAME})`, "g"),
  new RegExp(`\\bip[ \\t]+host[ \\t]+(${LETTER_NAME})`, "g"),
];
const HOST_NAMES = new RegExp(`\\b(?:ntp server|logging host|tacacs server|radius server|ip name-server)[ \\t]+(?:vrf[ \\t]+\\S+[ \\t]+)?([A-Za-z][A-Za-z0-9-]*(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,})`, "g");
// Words that follow these keywords in commands and output without being anyone's name.
const NOT_A_NAME = new Set(["all", "brief", "detail", "default", "any", "permit", "deny", "in", "out", "input", "output", "summary", "standard", "extended", "global", "forwarding", "definition", "name", "interface", "interfaces", "sequence", "seq", "remark", "log", "match", "set", "neighbor", "peer", "group", "type", "expanded", "match-any", "match-all", "resequence", "on", "off", "to", "from", "static", "connected", "ospf", "bgp", "eigrp", "rip", "isis", "mgmt", "management"]);

/**
 * Words that describe what a configuration object is for, not who it belongs to. A name is split on - _ . and :, and these
 * words are kept so the model can still read the purpose (GUEST-WIFI-IN) while the rest is replaced (ACME-BANK-OUT becomes
 * obj-3fa91c-OUT). Any word not listed here, and not added in Settings, is treated as identifying and replaced.
 */
const GENERIC_WORDS = new Set(`in out inbound outbound ingress egress ipv4 ipv6 v4 v6 pl rm acl rt pfx prefix prefixes list map policy filter
deny permit allow block any all default blackhole static connected ospf bgp isis eigrp rip mpls ldp te vpn vrf evpn vxlan l2 l3 peer peers
peering transit upstream downstream customer customers cust client clients partner internal external ext int mgmt management oob lan wan man
dmz inside outside guest guests wifi wlan corp corporate staff voice voip video data iot server servers user users backup primary secondary
main core edge access distribution agg aggregate summary uplink downlink loopback lo tunnel gre ipsec ssl ntp snmp ssh telnet syslog dns dhcp
http https web mail qos ef af cs be class remark mark police shape priority bulk critical best effort bogons bogon rfc1918 private public
anycast multicast unicast local remote site branch hq dc pop test lab prod rr reflector community communities as asn path set match nat
pat firewall fw router switch sw rtr dist spine leaf border pe ce p cpe hub spoke dual single failover active standby ha`.split(/\s+/));

/** A public autonomous system number: not private, documentation, reserved or transition. */
function isPublicAsn(n: number): boolean {
  if (!Number.isInteger(n) || n <= 0 || n >= 4294967295) return false;
  if (n === 23456 || n === 65535) return false;
  if ((n >= 64496 && n <= 65534) || (n >= 65536 && n <= 65551)) return false; // documentation and 16-bit private
  if (n >= 4200000000) return false; // 32-bit private
  return true;
}

const toInt = (ip: string) => ip.split(".").reduce((n, o) => n * 256 + Number(o), 0);
const fromInt = (n: number) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join(".");
const validV4 = (ip: string) => ip.split(".").every((o) => Number(o) <= 255 && String(Number(o)) === o.replace(/^0+(?=\d)/, ""));

/** Contiguous ones then zeros with at least 8 ones: a subnet mask, not an address. */
function isMask(n: number): boolean {
  const inv = (~n) >>> 0;
  return n >>> 24 === 255 && (inv & (inv + 1)) === 0;
}
const isWildcard = (n: number) => n !== 0 && isMask((~n) >>> 0);

function keepBitsV4(n: number): number | null {
  const a = n >>> 24;
  if (n === 0 || n === 0xffffffff || a === 127 || a >= 224) return null; // unspecified, broadcast, loopback, multicast, reserved
  if (a === 10) return 8;
  if (a === 172 && ((n >>> 16) & 0xf0) === 16) return 12;
  if (a === 192 && ((n >>> 16) & 0xff) === 168) return 16;
  if (a === 100 && ((n >>> 16) & 0xc0) === 64) return 10;
  if (a === 169 && ((n >>> 16) & 0xff) === 254) return 16;
  return 8; // public: the first octet stays, so it still looks public
}
const isPrivateV4 = (n: number) => {
  const a = n >>> 24;
  return a === 10 || (a === 172 && ((n >>> 16) & 0xf0) === 16) || (a === 192 && ((n >>> 16) & 0xff) === 168) || (a === 100 && ((n >>> 16) & 0xc0) === 64) || (a === 169 && ((n >>> 16) & 0xff) === 254) || a === 127 || a >= 224 || a === 0;
};

function expandV6(s: string): number[] | null {
  if (s.includes(".") || !isIPv6(s)) return null;
  const [head, tail, extra] = s.split("::");
  if (extra !== undefined) return null;
  const h = head ? head.split(":") : [];
  const t = tail === undefined ? [] : tail ? tail.split(":") : [];
  const fill = tail === undefined ? 0 : 8 - h.length - t.length;
  const groups = [...h, ...Array(Math.max(fill, 0)).fill("0"), ...t].map((g) => parseInt(g || "0", 16));
  return groups.length === 8 ? groups : null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PROCESS_KEY = randomBytes(32);

export class Pseudonymiser {
  private readonly key: Buffer;
  private readonly toFake = new Map<string, string>();
  private readonly toReal = new Map<string, string>();
  /** Strings in the real text that already look like a stand-in; none may be issued, or restoring would change them. */
  private readonly reserved = new Set<string>();
  private names: { real: string; fake: string }[] = [];
  private nameRe: RegExp | null = null;
  readonly stats: PseudonymStats = { addresses: 0, names: 0, macs: 0, asns: 0, removed: 0 };

  private readonly safe: Set<string>;

  constructor(opts: { key?: Buffer; devices?: string[]; networks?: string[]; terms?: string[]; safeWords?: string[] } = {}) {
    this.key = opts.key ?? PROCESS_KEY;
    this.safe = new Set([...GENERIC_WORDS, ...(opts.safeWords ?? []).map((w) => w.trim().toLowerCase()).filter(Boolean)]);
    for (const n of opts.networks ?? []) this.addName(n, "net");
    for (const n of opts.devices ?? []) this.addName(n, "dev");
    for (const n of opts.terms ?? []) this.addName(n, "obj");
  }

  /** Registers a name that must never leave as it is. Names shorter than two characters are too ambiguous to track. */
  addName(real: string, kind: "dev" | "net" | "user" | "domain" | "obj" = "dev"): void {
    const name = real.trim();
    if (name.length < 2 || /^\d+$/.test(name) || this.toFake.has(`n:${name}`)) return;
    const fake = this.nameFake(kind, name);
    this.toFake.set(`n:${name}`, fake);
    this.toReal.set(fake, name);
    this.names.push({ real: name, fake });
    this.names.sort((a, b) => b.real.length - a.real.length);
    this.nameRe = new RegExp(`(?<![A-Za-z0-9_])(?:${this.names.map((n) => escapeRe(n.real)).join("|")})(?![A-Za-z0-9_])`, "g");
    this.stats.names += 1;
  }

  /**
   * Registers the identifying part of a configuration object's name. The name is split into words; generic words and numbers
   * stay as they are, and each run of other words becomes one stand-in. A name made only of generic words is left alone.
   */
  private addObjectName(raw: string): void {
    const name = raw.replace(/[.:]+$/, "");
    const parts = name.split(/([-_.:])/);
    let run = "";
    const flush = () => { if (run) this.addName(run, "obj"); run = ""; };
    for (let i = 0; i < parts.length; i += 2) {
      const word = parts[i];
      const generic = word === "" || /^\d+$/.test(word) || this.safe.has(word.toLowerCase());
      if (generic) { flush(); continue; }
      run += (run ? parts[i - 1] : "") + word;
    }
    flush();
  }

  private nameFake(kind: string, name: string): string {
    let fake = "";
    for (let tweak = 0; tweak < 64; tweak++) {
      const h = createHmac("sha256", this.key).update(`name|${tweak}|${name}`).digest("hex").slice(0, 6);
      fake = kind === "domain" ? `domain-${h}.example` : `${kind}-${h}`;
      if (!this.toReal.has(fake) && !this.reserved.has(fake)) break;
    }
    return fake;
  }

  /** The real text turned out to contain a string shaped like a stand-in already issued: issue a different one. */
  private reissue(old: string): void {
    const entry = this.names.find((n) => n.fake === old);
    if (!entry) return;
    this.toReal.delete(old);
    const kind = old.startsWith("domain-") ? "domain" : old.slice(0, old.indexOf("-"));
    entry.fake = this.nameFake(kind, entry.real);
    this.toFake.set(`n:${entry.real}`, entry.fake);
    this.toReal.set(entry.fake, entry.real);
  }

  private bit(prefix: string, i: number, tweak: number): number {
    return createHmac("sha256", this.key).update(`${tweak}|${i}|${prefix}`).digest()[0] & 1;
  }

  /**
   * Prefix-preserving permutation of the bits between `keep` and `bits.length - low`: addresses that share a prefix keep
   * sharing a prefix. The last `low` bits are kept as they are.
   */
  private permute(bits: string, keep: number, tweak: number, low = 0): string {
    const end = bits.length - low;
    let out = bits.slice(0, keep);
    for (let i = keep; i < end; i++) out += (Number(bits[i]) ^ this.bit(bits.slice(0, i), i, tweak)).toString();
    return out + bits.slice(end);
  }

  private fakeV4(real: string): string | null {
    if (!validV4(real)) return null;
    const n = toInt(real);
    if (isMask(n) || isWildcard(n)) return null;
    const keep = keepBitsV4(n);
    if (keep === null) return null;
    const cached = this.toFake.get(`a:${real}`);
    if (cached) return cached;
    const bits = n.toString(2).padStart(32, "0");
    // The last octet is kept, and so is any longer run of zero bits that ends the address. That keeps subnet arithmetic exact:
    // a network address stays a network address, and 10.0.15.0/30 still holds .1 and .2 in the stand-in too.
    const zeros = 31 - Math.clz32(n & -n);
    const low = Math.min(Math.max(8, zeros), 32 - keep);
    for (let tweak = 0; tweak < 64; tweak++) {
      const candidate = fromInt(parseInt(this.permute(bits, keep, tweak, low), 2));
      const cn = toInt(candidate);
      const taken = this.toReal.has(candidate) && this.toReal.get(candidate) !== real;
      // A public address must not land in a private range, and nothing may map onto a mask or an address already issued.
      if (taken || candidate === real || isMask(cn) || isWildcard(cn) || (!isPrivateV4(n) && isPrivateV4(cn))) continue;
      this.toFake.set(`a:${real}`, candidate);
      this.toReal.set(candidate, real);
      this.stats.addresses += 1;
      return candidate;
    }
    return null;
  }

  private fakeV6(real: string): string | null {
    const groups = expandV6(real);
    if (!groups || (groups[0] >> 8) === 0xff || groups.every((g) => g === 0) || (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1)) return null;
    const key = `a:${real.toLowerCase()}`;
    const cached = this.toFake.get(key);
    if (cached) return cached;
    const bits = groups.map((g) => g.toString(2).padStart(16, "0")).join("");
    for (let tweak = 0; tweak < 64; tweak++) {
      const p = this.permute(bits, 16, tweak);
      const candidate = Array.from({ length: 8 }, (_, i) => parseInt(p.slice(i * 16, i * 16 + 16), 2).toString(16)).join(":");
      if (this.toReal.has(candidate) && this.toReal.get(candidate) !== real) continue;
      this.toFake.set(key, candidate);
      this.toReal.set(candidate, real);
      this.stats.addresses += 1;
      return candidate;
    }
    return null;
  }

  private fakeMac(real: string): string | null {
    const hex = real.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
    if (hex === "ffffffffffff" || hex === "000000000000") return null;
    const cached = this.toFake.get(`m:${hex}`);
    if (cached) return this.shapeMac(cached, real);
    for (let tweak = 0; tweak < 64; tweak++) {
      const d = createHmac("sha256", this.key).update(`mac|${tweak}|${hex}`).digest();
      const b = [...d.subarray(0, 6)];
      b[0] = (b[0] & 0xfc) | 0x02; // locally administered, unicast
      const fake = b.map((x) => x.toString(16).padStart(2, "0")).join("");
      if (fake === hex || (this.toReal.has(`m:${fake}`) && this.toReal.get(`m:${fake}`) !== hex)) continue;
      this.toFake.set(`m:${hex}`, fake);
      this.toReal.set(`m:${fake}`, hex);
      this.stats.macs += 1;
      return this.shapeMac(fake, real);
    }
    return null;
  }

  /** A public AS number becomes a number from the 32-bit private range, so it no longer says who the peer is. Private ones are not identifying. */
  private fakeAsn(real: string): string | null {
    const n = Number(real);
    if (!isPublicAsn(n)) return null;
    const cached = this.toFake.get(`s:${n}`);
    if (cached) return cached;
    for (let tweak = 0; tweak < 64; tweak++) {
      const d = createHmac("sha256", this.key).update(`asn|${tweak}|${n}`).digest();
      const fake = String(4200000000 + (d.readUInt32BE(0) % 94967294));
      if (this.toReal.has(`s:${fake}`) || this.reserved.has(fake)) continue;
      this.toFake.set(`s:${n}`, fake);
      this.toReal.set(`s:${fake}`, String(n));
      this.stats.asns += 1;
      return fake;
    }
    return null;
  }

  private maskAsn(s: string): string {
    const swap = (m: string, head: string, n: string) => { const f = this.fakeAsn(n); return f ? `${head}${f}` : m; };
    // Where a number is labelled as an AS number, and in the AS column of a BGP neighbour table.
    return s
      .replace(/(\b(?:router bgp|remote-as|local-as|peer-as|autonomous-system)[ \t]+)(\d{1,10})\b/g, swap)
      .replace(/(\bAS(?:[ \t]+number)?[ \t:#]*)(\d{1,10})\b/g, swap)
      .replace(/^([ \t]*[0-9A-Fa-f.:]+[ \t]+4[ \t]+)(\d{1,10})(?=[ \t])/gm, swap);
  }

  /** Writes a MAC in the same notation the original used. */
  private shapeMac(hex: string, like: string): string {
    if (like.includes(".")) return `${hex.slice(0, 4)}.${hex.slice(4, 8)}.${hex.slice(8, 12)}`;
    const sep = like.includes("-") ? "-" : ":";
    return hex.match(/../g)!.join(sep);
  }

  /** Learns hostnames, user names and domain names that the text itself declares. Call it on a whole request before masking any of it, so a name declared late is still hidden early. */
  learn(text: string): void {
    for (const m of text.matchAll(/^[ \t]*hostname[ \t]+([A-Za-z0-9._-]+)/gim)) this.addName(m[1], "dev");
    for (const m of text.matchAll(/^[ \t]*ip[ \t]+domain[- ](?:name[ \t]+)?([A-Za-z0-9._-]+\.[A-Za-z]{2,})/gim)) this.addName(m[1], "domain");
    for (const m of text.matchAll(/^[ \t]*username[ \t]+([A-Za-z0-9._@-]+)/gim)) this.addName(m[1], "user");
    for (const re of OBJECT_NAMES) for (const m of text.matchAll(re)) if (!NOT_A_NAME.has(m[1].toLowerCase())) this.addObjectName(m[1]);
    for (const m of text.matchAll(HOST_NAMES)) this.addName(m[1], "domain");
    // Anything already shaped like a stand-in must never be issued as one.
    for (const m of text.matchAll(TOKEN_ANYWHERE)) {
      this.reserved.add(m[0]);
      if (this.toReal.has(m[0])) this.reissue(m[0]);
    }
    for (const m of text.matchAll(ASN_STANDIN)) this.reserved.add(m[0]);
  }

  /** Real to stand-in. Safe to call on any text; text with nothing identifying comes back unchanged. */
  forward(text: string): string {
    if (!text) return text;
    this.learn(text);
    let s = text;
    // Free text a person typed into a configuration says things no address mask can: remove it.
    s = s.replace(/^([ \t]*(?:description|snmp-server (?:location|contact))[ \t]+).+$/gim, (_m, head: string) => { this.stats.removed += 1; return `${head}[removed]`; });
    s = s.replace(/(banner[ \t]+\w+[ \t]+)(\^C|\S)[\s\S]*?\2/gi, (_m, head: string) => { this.stats.removed += 1; return `${head}[removed]`; });
    if (this.nameRe) s = s.replace(this.nameRe, (m) => this.toFake.get(`n:${m}`) ?? m);
    s = this.maskAsn(s);
    s = s.replace(MAC_COLON, (m) => this.fakeMac(m) ?? m).replace(MAC_DOT, (m) => this.fakeMac(m) ?? m);
    s = s.replace(IPV6, (m) => this.fakeV6(m) ?? m);
    s = s.replace(IPV4, (m) => this.fakeV4(m) ?? m);
    return s;
  }

  /** Stand-in to real. Only stand-ins this instance issued are touched, so anything else the model wrote stays as written. */
  restore(text: string): string {
    if (!text) return text;
    let s = text;
    s = s.replace(TOKEN, (m) => this.toReal.get(m) ?? m);
    s = s.replace(MAC_COLON, (m) => this.restoreMac(m)).replace(MAC_DOT, (m) => this.restoreMac(m));
    s = s.replace(IPV6, (m) => this.toReal.get(m.toLowerCase()) ?? m);
    s = s.replace(IPV4, (m) => this.toReal.get(m) ?? m);
    s = s.replace(ASN_STANDIN, (m) => this.toReal.get(`s:${m}`) ?? m);
    return s;
  }

  private restoreMac(m: string): string {
    const real = this.toReal.get(`m:${m.replace(/[^0-9a-fA-F]/g, "").toLowerCase()}`);
    return real ? this.shapeMac(real, m) : m;
  }

  forwardDeep<T>(v: T, depth = 0): T {
    if (typeof v === "string") return this.forward(v) as T;
    if (depth > 12 || v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((x) => this.forwardDeep(x, depth + 1)) as T;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.forwardDeep(x, depth + 1)])) as T;
  }

  restoreDeep<T>(v: T, depth = 0): T {
    if (typeof v === "string") return this.restore(v) as T;
    if (depth > 12 || v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((x) => this.restoreDeep(x, depth + 1)) as T;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.restoreDeep(x, depth + 1)])) as T;
  }

  describe(): string {
    const { addresses, names, macs, asns, removed } = this.stats;
    return `${addresses} addresses, ${names} names, ${macs} MAC addresses, ${asns} AS numbers and ${removed} free-text lines replaced`;
  }
}

/**
 * Restores streamed text. A stand-in can arrive split across chunks, so the trailing part that could still be the start
 * of one is held back until the next chunk shows it has ended.
 */
export class StreamRestorer {
  private held = "";
  constructor(private readonly p: Pseudonymiser) {}
  push(delta: string): string {
    const all = this.held + delta;
    const tail = /[A-Za-z0-9_.:-]*$/.exec(all)?.[0] ?? "";
    const hold = tail.length > 80 ? "" : tail;
    this.held = hold;
    return this.p.restore(all.slice(0, all.length - hold.length));
  }
  flush(): string {
    const rest = this.held;
    this.held = "";
    return this.p.restore(rest);
  }
}
