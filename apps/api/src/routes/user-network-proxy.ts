import {
  getUserNetworkProxySettings,
  testUserNetworkProxy,
  updateUserNetworkProxySettings,
} from "../user-network-proxy-config.js";
import type { RouterContext } from "./context.js";

export function userNetworkProxyRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    userProxy: {
      get: authed.userProxy.get.handler(({ context }) =>
        getUserNetworkProxySettings(deps, context.actor),
      ),
      update: authed.userProxy.update.handler(({ context, input }) =>
        updateUserNetworkProxySettings(deps, context.actor, input),
      ),
      test: authed.userProxy.test.handler(({ context }) =>
        testUserNetworkProxy(deps, context.actor),
      ),
    },
  };
}
