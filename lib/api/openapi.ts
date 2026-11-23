import { CATALOG } from "../provisioning/catalog";
import { EVENTS } from "./webhooks";

/**
 * The description of the northbound API, as OpenAPI 3.1. It is written by hand next to the routes it describes and a
 * test checks that every path in it exists, so it cannot quietly drift from what the server does.
 */

type Op = { summary: string; role: "viewer" | "operator" | "approver"; params?: { name: string; in: "path" | "query"; description: string; required?: boolean }[]; body?: object; idempotent?: boolean; description?: string };

const ok = (description: string, schema: object = { type: "object" }) => ({ description, content: { "application/json": { schema } } });
const errors = {
  "400": { $ref: "#/components/responses/Error" },
  "401": { $ref: "#/components/responses/Error" },
  "403": { $ref: "#/components/responses/Error" },
  "404": { $ref: "#/components/responses/Error" },
  "429": { $ref: "#/components/responses/RateLimited" },
};

const operation = (o: Op) => ({
  summary: o.summary,
  ...(o.description ? { description: o.description } : {}),
  security: [{ bearer: [] }],
  "x-required-role": o.role,
  parameters: [
    ...(o.params ?? []).map((p) => ({ name: p.name, in: p.in, description: p.description, required: p.required ?? p.in === "path", schema: { type: "string" } })),
    ...(o.idempotent ? [{ name: "Idempotency-Key", in: "header", description: "Makes a retry safe: the same key with the same body returns the first answer instead of acting twice.", required: false, schema: { type: "string", maxLength: 128 } }] : []),
  ],
  ...(o.body ? { requestBody: { required: true, content: { "application/json": { schema: o.body } } } } : {}),
  responses: { "200": ok("Success"), ...errors },
});

const labId = { name: "labId", in: "path", description: "The network id, as listed by GET /api/v1/networks." } as const;
const changeId = { name: "id", in: "path", description: "The change id." } as const;

const proposal = {
  type: "object",
  required: ["title", "devices"],
  properties: {
    scopeId: { type: "string", description: "The network. Defaults to the selected one." },
    title: { type: "string", maxLength: 120 },
    intent: { type: "string", maxLength: 2000 },
    devices: { type: "array", minItems: 1, maxItems: 20, items: { type: "object", required: ["device", "commands"], properties: { device: { type: "string", description: "The device name as it appears in the network." }, commands: { type: "array", items: { type: "string", maxLength: 400 }, description: "Configuration lines without configure terminal or end." } } } },
    rollout: { type: "object", properties: { mode: { enum: ["all", "staged"] }, canary: { type: "integer" }, pauseAfterCanary: { type: "boolean" } } },
  },
};

const paths: Record<string, Record<string, Op>> = {
  "/api/v1/networks": { get: { summary: "List the networks", role: "viewer" } },
  "/api/v1/networks/{labId}/topology": { get: { summary: "Devices and links of a network", role: "viewer", params: [labId] } },
  "/api/v1/networks/{labId}/diagnostics": {
    get: { summary: "The latest diagnostics run and its open findings", role: "viewer", params: [labId] },
    post: { summary: "Run read-only diagnostics now", role: "operator", params: [labId], body: { type: "object", properties: { pings: { type: "boolean" } } }, description: "Reads the devices; changes nothing. Can take a minute or more." },
  },
  "/api/v1/networks/{labId}/history": { get: { summary: "Findings over the last runs", role: "viewer", params: [labId] } },
  "/api/v1/changes": {
    get: { summary: "List the changes of a network", role: "viewer", params: [{ name: "scope", in: "query", description: "The network id. Defaults to the selected one.", required: false }] },
    post: { summary: "Propose a change", role: "operator", body: proposal, idempotent: true, description: "Files a proposal. Nothing is sent to any device until a person with the approver role approves it and it is applied." },
  },
  "/api/v1/changes/{id}": { get: { summary: "One change with its plan, result and status", role: "viewer", params: [changeId] } },
  "/api/v1/changes/{id}/preview": { get: { summary: "Read the devices and show what the change would alter", role: "viewer", params: [changeId], description: "Reads each device now and changes nothing." } },
  "/api/v1/changes/{id}/{action}": {
    post: { summary: "Approve, reject, deploy, continue, schedule, roll back or save a change", role: "approver", params: [changeId, { name: "action", in: "path", description: "approve, reject, deploy, continue, schedule, rollback or save." }], body: { type: "object", properties: { at: { type: "string", format: "date-time", nullable: true }, overrideReason: { type: "string", description: "Administrators only: apply outside the maintenance window." } } }, description: "Deploy and rollback answer 202 and carry on in the background; poll the change until it settles." },
  },
  "/api/v1/backups": { get: { summary: "Devices with stored configuration versions, and open drift", role: "viewer", params: [{ name: "scope", in: "query", description: "The network id.", required: false }] } },
  "/api/v1/backups/{id}": { get: { summary: "One stored version with a diff against the one before it", role: "viewer", params: [{ name: "id", in: "path", description: "The backup id." }] } },
  "/api/v1/backups/run": { post: { summary: "Read and store the running configuration of every device now", role: "operator", body: { type: "object", properties: { scopeId: { type: "string" } } } } },
  "/api/v1/services": {
    get: { summary: "List the services provisioned in a network", role: "viewer", params: [{ name: "scope", in: "query", description: "The network id. Defaults to the selected one.", required: false }, { name: "retired", in: "query", description: "1 to include retired services.", required: false }] },
    post: { summary: "Provision a service", role: "operator", idempotent: true, body: { type: "object", required: ["serviceId", "name", "values", "devices"], properties: { scopeId: { type: "string" }, serviceId: { type: "string", enum: CATALOG.map((c) => c.id) }, name: { type: "string", description: "A name for this instance, unique in the network." }, values: { type: "object", description: "The fields the service takes; see GET /api/v1/provisioning." }, devices: { type: "array", items: { type: "string" } } } }, description: "Remembers the service and files the change that puts it on the devices. Nothing is sent until the change is approved and applied; the service becomes active when that change is verified." },
  },
  "/api/v1/services/impact": { get: { summary: "Which open findings hurt which services", role: "viewer", params: [{ name: "scope", in: "query", description: "The network id. Defaults to the selected one.", required: false }], description: "Joins the latest diagnostics findings with the devices and interfaces each service is bound to. A match is either interface (the finding is on, or at the far end of a link from, an interface the service uses) or device (the service lives on that device but is not tied to one interface). Read-only." } },
  "/api/v1/services/{id}": {
    get: { summary: "One service with the changes filed for it", role: "viewer", params: [{ name: "id", in: "path", description: "The service id." }] },
    put: { summary: "Change a service, or preview the change", role: "operator", params: [{ name: "id", in: "path", description: "The service id." }], body: { type: "object", properties: { name: { type: "string" }, values: { type: "object" }, devices: { type: "array", items: { type: "string" } }, dryRun: { type: "boolean", description: "Only show the lines each device would get." } } }, description: "Only an active service can be modified. Changing a field that makes it that service (the VLAN id, the interface) removes the old one and provisions the new one in a single change." },
    delete: { summary: "Stop tracking a service", role: "approver", params: [{ name: "id", in: "path", description: "The service id." }], description: "Sends nothing to any device: what is configured there stays configured. Use decommission to take it away." },
  },
  "/api/v1/services/{id}/decommission": { post: { summary: "Take a service away from its devices, or preview that", role: "operator", params: [{ name: "id", in: "path", description: "The service id." }], body: { type: "object", properties: { dryRun: { type: "boolean" } } }, description: "Files a change that removes the service. Some services cannot be removed automatically (a hostname, a VRF); the answer says why." } },
  "/api/v1/services/{id}/retry": { post: { summary: "Try a failed or never-applied service again, or preview that", role: "operator", params: [{ name: "id", in: "path", description: "The service id." }], body: { type: "object", properties: { dryRun: { type: "boolean" } } } } },
  "/api/v1/activity": { get: { summary: "The activity log, newest first", role: "viewer", params: [{ name: "limit", in: "query", description: "1 to 500.", required: false }, { name: "reads", in: "query", description: "1 to include background reads.", required: false }] } },
  "/api/v1/provisioning": { get: { summary: "The service catalogue: services and the fields each one takes", role: "viewer" } },
  "/api/v1/provisioning/render": { post: { summary: "Turn a service and its values into configuration lines per device", role: "operator", body: { type: "object", required: ["service", "values", "devices"], properties: { scopeId: { type: "string" }, service: { type: "string", enum: CATALOG.map((s) => s.id) }, values: { type: "object" }, devices: { type: "array", items: { type: "string" } } } }, description: "Previews only. Propose the lines with POST /api/v1/changes to act on them." } },
};

export function openApiDocument(baseUrl = "") {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [path, ops] of Object.entries(paths)) {
    out[path] = {};
    for (const [method, op] of Object.entries(ops)) out[path][method] = operation(op);
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Tiny Snitch API",
      version: "1.0.0",
      description: [
        "Read a network's state and drive its changes from another system. Every call goes through the same roles, approvals, safety rules, snapshots and audit as the web interface.",
        "Authenticate with an API token from Settings, API: send it as `Authorization: Bearer tsk_...`. A token has a role (viewer, operator, approver or admin) and may expire or be revoked. A token cannot manage users, tokens, webhooks or settings.",
        "Errors are JSON, `{ \"error\": \"...\", \"code\": \"...\" }`. Each token is limited to 300 requests per minute; past that the answer is 429 with a Retry-After header.",
        "A change proposed through the API still needs a person with the approver role to approve it unless the server is in Autopilot mode and the change is small and low-risk in a lab network.",
        `Webhooks: Tiny Snitch can call you when something happens. Events: ${EVENTS.join(", ")}. Each request is a POST of \`{ "id", "type", "createdAt", "data" }\` with headers X-TinySnitch-Event, X-TinySnitch-Delivery and X-TinySnitch-Signature (\`t=<unix seconds>,v1=<hex>\`). Compute HMAC-SHA256 with the webhook's secret over \`<t>.<raw body>\`, compare in constant time, and reject a timestamp more than five minutes old. Answer with any 2xx; otherwise delivery is retried after 1 min, 5 min, 30 min, 2 h and 6 h, then marked failed.`,
      ].join("\n\n"),
    },
    servers: baseUrl ? [{ url: baseUrl }] : [],
    paths: out,
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "An API token (tsk_...)." } },
      responses: {
        Error: { description: "An error", content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" }, code: { type: "string" } } } } } },
        RateLimited: { description: "Too many requests", headers: { "Retry-After": { schema: { type: "integer" }, description: "Seconds until the next request is allowed." } }, content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" }, code: { const: "rate_limited" } } } } } },
      },
    },
  };
}

/** Every path in the document, for the test that checks the routes exist. */
export const documentedPaths = (): string[] => Object.keys(paths);
