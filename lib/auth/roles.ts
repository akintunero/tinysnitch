/**
 * What each role may do. Roles are ordered: a higher role can do everything a lower one can.
 *  - viewer:   read everything (topology, findings, backups, activity). Changes nothing, reads no device.
 *  - operator: run diagnostics and backups, use the assistant, draft and propose changes.
 *  - approver: approve, apply, continue, schedule and roll back changes.
 *  - admin:    settings, users, connections, and applying a change outside its maintenance window.
 */
export const ROLES = ["viewer", "operator", "approver", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const roleRank = (r: Role) => ROLES.indexOf(r);
export const atLeast = (have: Role, need: Role) => roleRank(have) >= roleRank(need);
export const isRole = (v: unknown): v is Role => typeof v === "string" && (ROLES as readonly string[]).includes(v);

export const ROLE_TEXT: Record<Role, string> = {
  viewer: "Can look at everything; changes and reads nothing on devices.",
  operator: "Can run diagnostics and backups, use the assistant and propose changes.",
  approver: "Can also approve, apply, schedule and roll back changes.",
  admin: "Can also manage users and settings, and apply outside a maintenance window.",
};
