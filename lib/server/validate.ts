import { z } from "zod";

/**
 * Ids of networks and devices. CML ids are UUIDs; other providers use `provider:site` and `provider:site:device`, with
 * names that may hold dots and underscores. Only this conservative character set is accepted, so nothing odd is
 * ever passed on to a provider.
 */
export const LAB_ID = z.string().regex(/^[A-Za-z0-9._:-]{1,96}$/, "That is not a valid network id.");
export const NODE_ID = z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/);
