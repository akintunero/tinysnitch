import { HttpError } from "../server/http";
import { ServiceError } from "./instances";

/** Turns a service problem into the HTTP error with the right status; anything else is rethrown as it is. */
export const asHttp = (e: unknown): never => {
  if (e instanceof ServiceError) throw new HttpError(e.status, e.message);
  throw e;
};
