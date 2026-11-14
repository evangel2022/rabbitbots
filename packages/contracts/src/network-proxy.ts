import * as z from "zod";

/** Deployment-owned outbound proxy. `direct` ignores saved proxy settings; null inherits the environment. */
export const NETWORK_PROXY_MODES = ["direct", "proxy"] as const;
export const NetworkProxyMode = z.enum(NETWORK_PROXY_MODES);
export type NetworkProxyMode = z.infer<typeof NetworkProxyMode>;

export const NetworkProxySource = z.enum(["saved", "environment", "default"]);
export type NetworkProxySource = z.infer<typeof NetworkProxySource>;

/**
 * Safe view of the deployment proxy. The URL is never returned: it may contain a
 * username and password. `proxyHost` is only the host:port, and `hasCredentials`
 * says whether a username was saved without revealing it.
 */
export const NetworkProxySettingsSchema = z.object({
  configured: z.boolean(),
  mode: NetworkProxyMode,
  source: NetworkProxySource,
  proxyHost: z.string().nullable(),
  hasCredentials: z.boolean(),
  bypass: z.array(z.string()),
});
export type NetworkProxySettings = z.infer<typeof NetworkProxySettingsSchema>;

export const NetworkProxyUpdateSchema = z.object({
  mode: NetworkProxyMode,
  /** Full proxy URL, optionally with user:password@. Omit to keep the saved URL. */
  url: z.string().trim().max(2_048).optional(),
  /** Hostnames that bypass the proxy. Omit to keep the saved list. */
  bypass: z.array(z.string().trim().min(1).max(255)).max(200).optional(),
});
export type NetworkProxyUpdate = z.infer<typeof NetworkProxyUpdateSchema>;

export const NetworkProxyTestResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
});
export type NetworkProxyTestResult = z.infer<typeof NetworkProxyTestResultSchema>;
