import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DELETE as activityDelete } from "@/app/api/activity/route";
import { DELETE as changeDelete } from "@/app/api/changes/[id]/route";
import { POST as changesClearPost } from "@/app/api/changes/clear/route";
import { POST as actionPost } from "@/app/api/changes/[id]/[action]/route";
import { POST as backupRunPost } from "@/app/api/backups/run/route";
import { POST as loginPost } from "@/app/api/auth/login/route";
import { POST as logoutPost } from "@/app/api/auth/logout/route";
import { POST as passwordPost } from "@/app/api/auth/password/route";
import { GET as sessionGet } from "@/app/api/auth/session/route";
import { POST as setupPost } from "@/app/api/auth/setup/route";
import { GET as settingsGet, PUT as settingsPut } from "@/app/api/settings/route";
import { DELETE as userDelete, PUT as userPut } from "@/app/api/users/[id]/route";
import { GET as usersGet, POST as usersPost } from "@/app/api/users/route";
import { atLeast } from "@/lib/auth/roles";
import { dummyHash, hashPassword, passwordProblem, verifyPassword } from "@/lib/auth/password";
import { LIMITS, resetThrottle } from "@/lib/auth/throttle";
import { SESSION_IDLE_MS, SESSION_MAX_MS, checkLogin, countUsers, createSession, createUser, deleteUser, endSession, getUserByName, otherApprovers, sessionUser, setPassword, updateUser } from "@/lib/auth/store";
import { approveChange, proposeChange, resetChangeLocks } from "@/lib/changes/engine";
import { createChange, getChange } from "@/lib/changes/store";
import { openDatabase } from "@/lib/database/db";
import { listAudit, saveSettings } from "@/lib/database/repo";
import { setProviders } from "@/lib/providers/registry";
import { StaticProvider } from "@/lib/providers/static";
import { actorName, runAs } from "@/lib/security/actor";
import { setContext } from "@/lib/server/context";
import { type StatefulDevice, startStatefulDevice } from "./helpers/fake-device";

const PW = "correct horse battery";
const ctxWith = (db = openDatabase(":memory:")) => { setContext({ db, mcp: null, mcpConfig: null, mcpConfigError: "no cml", claude: { configured: false, model: null, configError: null, verification: "unverified", checkedAt: null, error: null }, llm: null, lastConnectAttempt: 0 }); return db; };

describe("passwords", () => {
  it("hashes with a salt, verifies, and rejects a wrong or malformed one", async () => {
    const a = await hashPassword(PW), b = await hashPassword(PW);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(a).not.toContain(PW);
    expect(await verifyPassword(PW, a)).toBe(true);
    expect(await verifyPassword("correct horse batterx", a)).toBe(false);
    expect(await verifyPassword(PW, "garbage")).toBe(false);
    expect(await verifyPassword(PW, await dummyHash())).toBe(false);
  });
  it("asks for length, not for symbols, and refuses the obvious", () => {
    expect(passwordProblem("short", "bob")).toMatch(/at least 12/);
    expect(passwordProblem("aaaaaaaaaaaaaaaa", "bob")).toMatch(/too few different/);
    expect(passwordProblem("passwordpassword", "bob")).toMatch(/common/);
    expect(passwordProblem("bob is my name ok", "bob")).toMatch(/must not contain the username/);
    expect(passwordProblem(PW, "bob")).toBeNull();
    expect(passwordProblem("just words with spaces in", "bob")).toBeNull();
  });
});

describe("users and sessions", () => {
  it("creates users with checked names, roles and passwords, and refuses a duplicate in any case", async () => {
    const db = ctxWith();
    await expect(createUser(db, { username: "a b", password: PW, role: "admin" })).rejects.toThrow(/3 to 40 letters/);
    await expect(createUser(db, { username: "alice", password: "short", role: "admin" })).rejects.toThrow(/12 characters/);
    await expect(createUser(db, { username: "alice", password: PW, role: "root" as never })).rejects.toThrow(/Unknown role/);
    await createUser(db, { username: "alice", password: PW, role: "admin" });
    await expect(createUser(db, { username: "ALICE", password: PW, role: "viewer" })).rejects.toThrow(/taken/);
    expect(countUsers(db)).toBe(1);
    expect(JSON.stringify(getUserByName(db, "alice"))).not.toMatch(/scrypt|password/i);
  });

  it("answers a wrong name, a wrong password and a disabled account identically", async () => {
    const db = ctxWith();
    const u = await createUser(db, { username: "alice", password: PW, role: "admin" });
    await createUser(db, { username: "bob", password: PW, role: "operator" });
    expect(await checkLogin(db, "alice", PW)).toMatchObject({ username: "alice" });
    expect(await checkLogin(db, "alice", "wrong password here")).toBeNull();
    expect(await checkLogin(db, "nobody", PW)).toBeNull();
    updateUser(db, getUserByName(db, "bob")!.id, { disabled: true });
    expect(await checkLogin(db, "bob", PW)).toBeNull();
    expect(u.role).toBe("admin");
  });

  it("stores only a hash of the session token, and ends a session on logout", async () => {
    const db = ctxWith();
    const u = await createUser(db, { username: "alice", password: PW, role: "admin" });
    const { token } = createSession(db, u.id);
    expect(JSON.stringify(db.prepare("SELECT * FROM sessions").all())).not.toContain(token);
    expect(sessionUser(db, token)?.username).toBe("alice");
    endSession(db, token);
    expect(sessionUser(db, token)).toBeNull();
    expect(sessionUser(db, "not-a-token")).toBeNull();
  });

  it("expires a session that is idle too long, or that is simply too old", async () => {
    const db = ctxWith();
    const u = await createUser(db, { username: "alice", password: PW, role: "admin" });
    const t0 = Date.now();
    const { token } = createSession(db, u.id, t0);
    expect(sessionUser(db, token, t0 + SESSION_IDLE_MS - 1000)?.username).toBe("alice");
    // Activity slides the idle limit, but never past the absolute one.
    let t = t0;
    while (t + SESSION_IDLE_MS - 1000 < t0 + SESSION_MAX_MS) { t += SESSION_IDLE_MS - 1000; expect(sessionUser(db, token, t)).not.toBeNull(); }
    expect(sessionUser(db, token, t0 + SESSION_MAX_MS + 1000)).toBeNull();
    const { token: t2 } = createSession(db, u.id, t0);
    expect(sessionUser(db, t2, t0 + SESSION_IDLE_MS + 1000)).toBeNull();
  });

  it("signs a user out everywhere when they are disabled, change role or get a new password, except the session that changed it", async () => {
    const db = ctxWith();
    const a = await createUser(db, { username: "alice", password: PW, role: "admin" });
    const b = await createUser(db, { username: "bob", password: PW, role: "operator" });
    const s1 = createSession(db, b.id).token, s2 = createSession(db, b.id).token;
    await setPassword(db, b.id, "another long password!", s1);
    expect(sessionUser(db, s1)).not.toBeNull();
    expect(sessionUser(db, s2)).toBeNull();
    updateUser(db, b.id, { role: "approver" });
    expect(sessionUser(db, s1)).toBeNull();
    const s3 = createSession(db, b.id).token;
    updateUser(db, b.id, { disabled: true });
    expect(sessionUser(db, s3)).toBeNull();
    expect(a.id).toBeTruthy();
  });

  it("never leaves the app without an administrator who can sign in", async () => {
    const db = ctxWith();
    const a = await createUser(db, { username: "alice", password: PW, role: "admin" });
    expect(() => deleteUser(db, a.id)).toThrow(/at least one administrator/);
    expect(() => updateUser(db, a.id, { role: "viewer" })).toThrow(/at least one administrator/);
    expect(() => updateUser(db, a.id, { disabled: true })).toThrow(/at least one administrator/);
    const b = await createUser(db, { username: "bob", password: PW, role: "admin" });
    expect(() => deleteUser(db, a.id)).not.toThrow();
    expect(() => deleteUser(db, b.id)).toThrow(/at least one administrator/);
  });

  it("counts the other people who could approve", async () => {
    const db = ctxWith();
    await createUser(db, { username: "alice", password: PW, role: "approver" });
    expect(otherApprovers(db, "alice")).toBe(0);
    await createUser(db, { username: "bob", password: PW, role: "admin" });
    const c = await createUser(db, { username: "carol", password: PW, role: "operator" });
    await createUser(db, { username: "dave", password: PW, role: "approver" });
    updateUser(db, getUserByName(db, "dave")!.id, { disabled: true });
    expect(otherApprovers(db, "alice")).toBe(1);
    expect(c.role).toBe("operator");
  });

  it("orders roles", () => {
    expect(atLeast("admin", "viewer") && atLeast("approver", "operator") && atLeast("viewer", "viewer")).toBe(true);
    expect(atLeast("operator", "approver")).toBe(false);
  });
});

// ---- through the real route handlers, the way a browser calls them -------------------------------------------------
class Browser {
  cookie = "";
  headers: Record<string, string> = {};
  async call(handler: (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>, path: string, opts: { method?: string; body?: unknown; params?: Record<string, string>; headers?: Record<string, string> } = {}) {
    const method = opts.method ?? "GET";
    const req = new Request(`http://localhost${path}`, {
      method, body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      headers: { host: "localhost", ...(method === "GET" ? {} : { "content-type": "application/json" }), ...(this.cookie ? { cookie: this.cookie } : {}), ...opts.headers },
    });
    const res = await handler(req, { params: Promise.resolve(opts.params ?? {}) });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.includes("Max-Age=0") ? "" : set.split(";")[0];
    return { status: res.status, setCookie: set, json: (await res.clone().json().catch(() => null)) as Record<string, any> | null, res };
  }
}

describe("login over the API", () => {
  beforeEach(() => { resetThrottle(); delete process.env.APP_HOST; delete process.env.TS_SETUP_TOKEN; });
  afterEach(() => { setContext(undefined); delete process.env.APP_HOST; delete process.env.TS_SETUP_TOKEN; });

  it("stays open on a loopback install until the first administrator is created, as it was before login existed", async () => {
    ctxWith();
    const b = new Browser();
    expect((await b.call(settingsGet, "/api/settings")).status).toBe(200);
    const s = (await b.call(sessionGet, "/api/auth/session")).json!;
    expect(s).toMatchObject({ authEnabled: false, setupRequired: false, user: null });
  });

  it("creates the first administrator once, signs them in with a safe cookie, and then closes the API to everyone else", async () => {
    ctxWith();
    const b = new Browser();
    const r = await b.call(setupPost, "/api/auth/setup", { method: "POST", body: { username: "alice", password: PW } });
    expect(r.status).toBe(201);
    expect(r.setCookie).toMatch(/^ts_session=[\w-]{40,}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
    expect(r.setCookie).not.toContain("Secure"); // plain http on localhost
    expect((await b.call(settingsGet, "/api/settings")).status).toBe(200);
    expect((await new Browser().call(settingsGet, "/api/settings")).json).toMatchObject({ code: "auth_required" });
    expect((await new Browser().call(setupPost, "/api/auth/setup", { method: "POST", body: { username: "mallory", password: PW } })).status).toBe(409);
    expect((await b.call(sessionGet, "/api/auth/session")).json).toMatchObject({ authEnabled: true, user: { username: "alice", role: "admin" } });
  });

  it("marks the cookie Secure when the page is served over https", async () => {
    ctxWith();
    const r = await new Browser().call(setupPost, "/api/auth/setup", { method: "POST", body: { username: "alice", password: PW }, headers: { "x-forwarded-proto": "https" } });
    expect(r.setCookie).toContain("; Secure");
  });

  it("refuses to run open when it listens beyond this machine, and needs the setup token to create the first administrator", async () => {
    process.env.APP_HOST = "0.0.0.0";
    process.env.TS_SETUP_TOKEN = "s3cret-setup-token-123";
    ctxWith();
    const b = new Browser();
    expect((await b.call(settingsGet, "/api/settings")).json).toMatchObject({ code: "setup_required" });
    expect((await b.call(sessionGet, "/api/auth/session")).json).toMatchObject({ authEnabled: false, setupRequired: true, exposed: true });
    expect((await b.call(setupPost, "/api/auth/setup", { method: "POST", body: { username: "alice", password: PW } })).json).toMatchObject({ code: "bad_setup_token" });
    expect((await b.call(setupPost, "/api/auth/setup", { method: "POST", body: { username: "alice", password: PW, setupToken: "wrong" } })).status).toBe(403);
    expect((await b.call(setupPost, "/api/auth/setup", { method: "POST", body: { username: "alice", password: PW, setupToken: "s3cret-setup-token-123" } })).status).toBe(201);
    expect((await b.call(settingsGet, "/api/settings")).status).toBe(200);
  });

  it("checks a weak first password", async () => {
    ctxWith();
    expect((await new Browser().call(setupPost, "/api/auth/setup", { method: "POST", body: { username: "alice", password: "short" } })).json?.error).toMatch(/12 characters/);
  });

  it("gives the same answer for a wrong password and an unknown user, and locks a name after repeated failures", async () => {
    const db = ctxWith();
    await createUser(db, { username: "alice", password: PW, role: "admin" });
    const b = new Browser();
    const wrong = await b.call(loginPost, "/api/auth/login", { method: "POST", body: { username: "alice", password: "not the password" } });
    const unknown = await b.call(loginPost, "/api/auth/login", { method: "POST", body: { username: "nobody", password: "not the password" } });
    expect(wrong.status).toBe(401);
    expect(wrong.json).toEqual(unknown.json);
    for (let i = 0; i < LIMITS.perName - 1; i++) await b.call(loginPost, "/api/auth/login", { method: "POST", body: { username: "alice", password: "still wrong" } });
    const locked = await b.call(loginPost, "/api/auth/login", { method: "POST", body: { username: "alice", password: PW } }); // even the right one
    expect(locked.status).toBe(429);
    expect(locked.json?.error).toMatch(/Too many failed sign-ins/);
    expect((await b.call(loginPost, "/api/auth/login", { method: "POST", body: { username: "bob2", password: PW } })).status).toBe(401); // other names are not affected
  });

  it("signs in and out, and the old cookie stops working", async () => {
    const db = ctxWith();
    await createUser(db, { username: "alice", password: PW, role: "admin" });
    const b = new Browser();
    expect((await b.call(settingsGet, "/api/settings")).status).toBe(401);
    expect((await b.call(loginPost, "/api/auth/login", { method: "POST", body: { username: "alice", password: PW } })).status).toBe(200);
    const old = b.cookie;
    expect((await b.call(settingsGet, "/api/settings")).status).toBe(200);
    expect((await b.call(logoutPost, "/api/auth/logout", { method: "POST", body: {} })).status).toBe(200);
    expect(b.cookie).toBe("");
    const replay = new Browser(); replay.cookie = old;
    expect((await replay.call(settingsGet, "/api/settings")).status).toBe(401);
  });

  it("refuses a sign-in that comes from another site", async () => {
    const db = ctxWith();
    await createUser(db, { username: "alice", password: PW, role: "admin" });
    const r = await new Browser().call(loginPost, "/api/auth/login", { method: "POST", body: { username: "alice", password: PW }, headers: { origin: "http://evil.example" } });
    expect(r.status).toBe(403);
    expect(r.setCookie).toBeNull();
  });
});

describe("roles on the API", () => {
  beforeEach(() => resetThrottle());
  afterEach(() => setContext(undefined));

  async function people() {
    const db = ctxWith();
    const out = {} as Record<"alice" | "dan" | "bob" | "carol", Browser>;
    for (const [name, role] of [["alice", "admin"], ["dan", "approver"], ["bob", "operator"], ["carol", "viewer"]] as const) {
      await createUser(db, { username: name, password: PW, role });
      out[name] = new Browser();
      expect((await out[name].call(loginPost, "/api/auth/login", { method: "POST", body: { username: name, password: PW } })).status).toBe(200);
    }
    return { db, ...out };
  }

  it("lets a viewer read, and nothing else", async () => {
    const { carol } = await people();
    expect((await carol.call(settingsGet, "/api/settings")).status).toBe(200);
    expect((await carol.call(backupRunPost, "/api/backups/run", { method: "POST", body: {} })).json).toMatchObject({ code: "forbidden" });
    expect((await carol.call(usersGet, "/api/users")).status).toBe(403);
  });
  it("lets an operator work but not decide or configure", async () => {
    const { bob } = await people();
    expect((await bob.call(backupRunPost, "/api/backups/run", { method: "POST", body: {} })).status).toBe(409); // it got past the role check: no network is selected
    expect((await bob.call(settingsPut, "/api/settings", { method: "PUT", body: { complianceChecks: "all" } })).status).toBe(403);
    expect((await bob.call(actionPost, "/api/changes/x/approve", { method: "POST", body: {}, params: { id: "x", action: "approve" } })).status).toBe(403);
  });
  it("lets an approver decide, and sends a missing change to 404 rather than 403", async () => {
    const { dan } = await people();
    expect((await dan.call(actionPost, "/api/changes/x/approve", { method: "POST", body: {}, params: { id: "x", action: "approve" } })).status).toBe(404);
    expect((await dan.call(settingsPut, "/api/settings", { method: "PUT", body: { complianceChecks: "all" } })).status).toBe(403);
  });
  it("keeps deleting and clearing to the roles that own them", async () => {
    const { bob, dan, alice } = await people();
    // a change: approver and up
    expect((await bob.call(changeDelete, "/api/changes/x", { method: "DELETE", body: {}, params: { id: "x" } })).status).toBe(403);
    expect((await dan.call(changeDelete, "/api/changes/x", { method: "DELETE", body: {}, params: { id: "x" } })).status).toBe(404);
    expect((await bob.call(changesClearPost, "/api/changes/clear", { method: "POST", body: { scopeId: "s" } })).status).toBe(403);
    expect((await dan.call(changesClearPost, "/api/changes/clear", { method: "POST", body: { scopeId: "s" } })).status).toBe(200);
    // the activity log: administrators only
    expect((await dan.call(activityDelete, "/api/activity?mode=reads", { method: "DELETE", body: {} })).status).toBe(403);
    expect((await alice.call(activityDelete, "/api/activity?mode=reads", { method: "DELETE", body: {} })).status).toBe(200);
  });
  it("keeps the maintenance-window override for administrators", async () => {
    const { dan, alice } = await people();
    const body = { overrideReason: "customer outage, ticket 4411" };
    expect((await dan.call(actionPost, "/api/changes/x/deploy", { method: "POST", body, params: { id: "x", action: "deploy" } })).status).toBe(403);
    expect((await alice.call(actionPost, "/api/changes/x/deploy", { method: "POST", body, params: { id: "x", action: "deploy" } })).status).toBe(404);
  });
  it("lets an administrator manage settings and users, weak passwords refused", async () => {
    const { alice, db } = await people();
    expect((await alice.call(settingsPut, "/api/settings", { method: "PUT", body: { complianceChecks: "all" } })).status).toBe(200);
    expect((await alice.call(usersPost, "/api/users", { method: "POST", body: { username: "erin", password: "short", role: "viewer" } })).json?.error).toMatch(/12 characters/);
    const created = await alice.call(usersPost, "/api/users", { method: "POST", body: { username: "erin", password: PW, role: "viewer" } });
    expect(created.status).toBe(201);
    expect(JSON.stringify(created.json)).not.toMatch(/scrypt|password_hash/);
    const id = created.json!.id as string;
    expect((await alice.call(userPut, `/api/users/${id}`, { method: "PUT", body: { role: "operator" }, params: { id } })).json).toMatchObject({ role: "operator" });
    expect((await alice.call(userDelete, `/api/users/${id}`, { method: "DELETE", body: {}, params: { id } })).status).toBe(200);
    expect(getUserByName(db, "erin")).toBeNull();
  });
  it("will not remove the last administrator over the API", async () => {
    const db = ctxWith();
    await createUser(db, { username: "alice", password: PW, role: "admin" });
    const a = new Browser();
    await a.call(loginPost, "/api/auth/login", { method: "POST", body: { username: "alice", password: PW } });
    const id = getUserByName(db, "alice")!.id;
    expect((await a.call(userDelete, `/api/users/${id}`, { method: "DELETE", body: {}, params: { id } })).status).toBe(409);
    expect((await a.call(userPut, `/api/users/${id}`, { method: "PUT", body: { role: "viewer" }, params: { id } })).status).toBe(409);
  });
  it("signs out a person who is disabled, at their next request", async () => {
    const { alice, bob, db } = await people();
    const id = getUserByName(db, "bob")!.id;
    expect((await bob.call(settingsGet, "/api/settings")).status).toBe(200);
    await alice.call(userPut, `/api/users/${id}`, { method: "PUT", body: { disabled: true }, params: { id } });
    expect((await bob.call(settingsGet, "/api/settings")).status).toBe(401);
  });
  it("lets a person change their own password, with the current one, and signs out their other sessions", async () => {
    const { bob, db } = await people();
    const other = new Browser();
    await other.call(loginPost, "/api/auth/login", { method: "POST", body: { username: "bob", password: PW } });
    expect((await bob.call(passwordPost, "/api/auth/password", { method: "POST", body: { current: "wrong wrong wrong", next: "a brand new long password" } })).status).toBe(403);
    expect((await bob.call(passwordPost, "/api/auth/password", { method: "POST", body: { current: PW, next: "tiny" } })).json?.error).toMatch(/12 characters/);
    expect((await bob.call(passwordPost, "/api/auth/password", { method: "POST", body: { current: PW, next: "a brand new long password" } })).status).toBe(200);
    expect((await bob.call(settingsGet, "/api/settings")).status).toBe(200);
    expect((await other.call(settingsGet, "/api/settings")).status).toBe(401);
    expect(await checkLogin(db, "bob", "a brand new long password")).not.toBeNull();
  });
  it("names the person in the audit log", async () => {
    const { alice, db } = await people();
    await alice.call(usersPost, "/api/users", { method: "POST", body: { username: "frank", password: PW, role: "viewer" } });
    const e = listAudit(db, 50).find((x) => x.summary.startsWith("Created user frank"));
    expect(e?.actor).toBe("user:alice");
    expect(listAudit(db, 50).some((x) => x.kind === "auth" && x.summary === "alice signed in" && x.actor === "user:alice")).toBe(true);
  });
  it("keeps a failed sign-in out of the way of a real one, and never logs a password", async () => {
    const { db } = await people();
    await new Browser().call(loginPost, "/api/auth/login", { method: "POST", body: { username: "alice", password: "hunter2hunter2!" } });
    const text = JSON.stringify(listAudit(db, 100));
    expect(text).not.toContain("hunter2hunter2");
    expect(text).toContain("Failed sign-in");
  });
});

describe("approval by a second person", () => {
  let dev: StatefulDevice | null = null;
  afterEach(() => { dev?.close(); dev = null; setProviders(null); setContext(undefined); resetChangeLocks(); });

  const prodChange = (db: ReturnType<typeof openDatabase>, createdBy: string | null, environment: "lab" | "production" = "production") =>
    createChange(db, { scopeId: "s", environment, title: "t", intent: "t", source: "user", plan: { devices: [], warnings: [] }, createdBy });

  it("stops the proposer approving their own production change when someone else could", async () => {
    const db = ctxWith();
    await createUser(db, { username: "alice", password: PW, role: "approver" });
    await createUser(db, { username: "bob", password: PW, role: "approver" });
    const c = prodChange(db, "alice");
    expect(() => approveChange(c.id, "alice")).toThrow(/second person/);
    expect(getChange(db, c.id)?.status).toBe("proposed");
    expect(approveChange(c.id, "bob").approvedBy).toBe("bob");
  });
  it("lets them approve it when nobody else can, and records that", async () => {
    const db = ctxWith();
    await createUser(db, { username: "alice", password: PW, role: "admin" });
    const c = prodChange(db, "alice");
    expect(approveChange(c.id, "alice").status).toBe("approved");
    expect(listAudit(db, 20).some((e) => e.summary.includes("approved by its proposer: no other approver exists"))).toBe(true);
  });
  it("does not apply to labs, to a network with the rule turned off, or when login is off", async () => {
    const db = ctxWith();
    await createUser(db, { username: "alice", password: PW, role: "approver" });
    await createUser(db, { username: "bob", password: PW, role: "approver" });
    expect(approveChange(prodChange(db, "alice", "lab").id, "alice").status).toBe("approved");
    saveSettings(db, { requireSecondApprover: false });
    expect(approveChange(prodChange(db, "alice").id, "alice").status).toBe("approved");
    const open = ctxWith(); // no users: login is off
    expect(approveChange(prodChange(open, "someone").id, "someone").status).toBe("approved");
  });
  it("records who proposed a change", async () => {
    dev = await startStatefulDevice({ host: "R1", config: "hostname R1\ninterface GigabitEthernet0/1\n shutdown\n" });
    process.env.TS_TEST_PW = "secret";
    const file = join(mkdtempSync(join(tmpdir(), "ts-au-")), "inv.yaml");
    writeFileSync(file, `credentials:\n  c: { username: admin, password: env:TS_TEST_PW }\nsites:\n  - id: s\n    title: S\n    environment: lab\n    credential: c\n    devices:\n      - { name: R1, address: 127.0.0.1, port: ${dev.port}, platform: ios, kind: router }\n`);
    ctxWith();
    setProviders([new StaticProvider(file)]);
    const c = await runAs({ username: "bob", role: "operator" }, () => proposeChange({ scopeId: "static:s", title: "t", intent: "t", source: "assistant", devices: [{ device: "R1", commands: ["interface Gi0/1", "description x"] }] }));
    expect(c.createdBy).toBe("bob");
    expect(runAs({ username: "bob", role: "operator" }, actorName)).toBe("user:bob");
    expect(actorName()).toBe("user");
  });
});
