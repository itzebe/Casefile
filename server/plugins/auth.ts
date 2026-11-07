import { createToolkitAuthPlugin } from "@agent-native/toolkit/app/auth/server";

import { assertAuthNotDisabledInDeployment } from "../casefile/auth-guard.js";

/**
 * Authentication plugin.
 *
 * `rootAuth: true` requires a signed-in session for the app, and `/` is public
 * only so the sign-in page can render. The wrapper below adds a fail-closed
 * check: the framework reports `AUTH_DISABLED` in production but does not refuse
 * to boot with it, so without this a deploy that inherited the flag would serve
 * every caller as one shared identity.
 */
const plugin = createToolkitAuthPlugin({
  workspaceAppPublicPaths: ["/"],
  rootAuth: true,
  marketing: false,
});

type AuthPlugin = typeof plugin;

const guarded: AuthPlugin = ((nitroApp: Parameters<AuthPlugin>[0]) => {
  assertAuthNotDisabledInDeployment();
  return plugin(nitroApp);
}) as AuthPlugin;

export default guarded;
