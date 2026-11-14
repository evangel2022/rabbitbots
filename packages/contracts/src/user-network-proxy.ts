import * as z from "zod";
import { NetworkProxyTestResultSchema } from "./network-proxy.js";

/** A person's own model egress choice. `inherit` follows the deployment default. */
export const USER_NETWORK_PROXY_MODES = ["inherit", "direct", "custom"] as const;
export const UserNetworkProxyMode = z.enum(USER_NETWORK_PROXY_MODES);
export type UserNetworkProxyMode = z.infer<typeof UserNetworkProxyMode>;

export const UserNetworkProxySource = z.enum([
  "saved",
  "deployment",
  "environment",
  "default",
  "direct",
]);
export type UserNetworkProxySource = z.infer<typeof UserNetworkProxySource>;

/** Safe user view. A custom URL is never returned because it may carry a password. */
export const UserNetworkProxySettingsSchema = z.object({
  mode: UserNetworkProxyMode,
  source: UserNetworkProxySource,
  proxyHost: z.string().nullable(),
  hasCredentials: z.boolean(),
  bypass: z.array(z.string()),
  /** Deployment default host only, so the user can see what inherit resolves to. */
  deploymentProxyHost: z.string().nullable(),
  deploymentProxyConfigured: z.boolean(),
});
export type UserNetworkProxySettings = z.infer<typeof UserNetworkProxySettingsSchema>;

export const UserNetworkProxyUpdateSchema = z.object({
  mode: UserNetworkProxyMode,
  /** Full custom proxy URL, optionally with credentials. Omit to keep the saved URL. */
  url: z.string().trim().max(2_048).optional(),
  bypass: z.array(z.string().trim().min(1).max(255)).max(200).optional(),
});
export type UserNetworkProxyUpdate = z.infer<typeof UserNetworkProxyUpdateSchema>;

export const UserNetworkProxyTestResultSchema = NetworkProxyTestResultSchema;
export type UserNetworkProxyTestResult = z.infer<typeof UserNetworkProxyTestResultSchema>;
