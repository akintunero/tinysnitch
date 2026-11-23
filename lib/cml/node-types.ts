/** Maps a CML node definition id (iosv, iosvl2, alpine, ...) to a display category. Unknown ids are "other". */
export type NodeKind = "router" | "l2switch" | "l3switch" | "firewall" | "server" | "host" | "pc" | "connector" | "other";

export const KIND_LABEL: Record<NodeKind, string> = {
  router: "Router",
  l2switch: "L2 switch",
  l3switch: "L3 switch",
  firewall: "Firewall",
  server: "Server",
  host: "Linux host",
  pc: "PC",
  connector: "Connector",
  other: "Other",
};

const RULES: [RegExp, NodeKind][] = [
  [/^external_connector$/, "connector"],
  [/^unmanaged_switch$/, "l2switch"],
  [/(l2|iosvl2)/, "l2switch"],
  [/(asav|ftd|fmc|firepower|pfsense|fortigate|palo|vsrx)/, "firewall"],
  [/(cat9000v|cat9kv|nxosv|n9k|n9000)/, "l3switch"],
  [/(csr|iosv|iosxr|iol|cat8000v|c8000|xrd|ios)/, "router"],
  [/^desktop/, "pc"],
  [/^(server|ubuntu|debian|centos)/, "server"],
  [/^(alpine|linux|trex|tinycore)/, "host"],
];

export function classifyNode(definition: string): NodeKind {
  const d = definition.toLowerCase();
  return RULES.find(([re]) => re.test(d))?.[1] ?? "other";
}
