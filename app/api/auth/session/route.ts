import { authState, userFor } from "@/lib/auth/access";
import { ROLE_TEXT } from "@/lib/auth/roles";
import { getContext } from "@/lib/server/context";
import { json, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Whether login is on, whether the app is waiting to be set up, and who is signed in. Open to anyone: it says nothing secret. */
export const GET = route(async (req) => {
  const { db } = getContext();
  const st = authState(db);
  const user = st.enabled ? userFor(req, db) : null;
  return json({
    authEnabled: st.enabled, setupRequired: st.setupRequired, exposed: st.exposed,
    user: user ? { username: user.username, role: user.role, roleText: ROLE_TEXT[user.role] } : null,
  });
}, { public: true });
