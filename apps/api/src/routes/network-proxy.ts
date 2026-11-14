import {
  getNetworkProxySettings,
  testNetworkProxy,
  updateNetworkProxySettings,
} from "../network-proxy-config.js";
import type { RouterContext } from "./context.js";

export function networkProxyRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    networkProxy: {
      get: authed.networkProxy.get.handler(({ context }) =>
        getNetworkProxySettings(deps, context.actor),
      ),
      update: authed.networkProxy.update.handler(({ context, input }) =>
        updateNetworkProxySettings(deps, context.actor, input),
      ),
      test: authed.networkProxy.test.handler(({ context }) =>
        testNetworkProxy(deps, context.actor),
      ),
    },
  };
}
