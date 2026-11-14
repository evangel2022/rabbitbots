-- Per-user model outbound proxy. A missing row inherits the deployment default.
CREATE TABLE "user_network_proxies" (
    "userId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'inherit',
    "proxy_cipher" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "user_network_proxies_pkey" PRIMARY KEY ("userId")
);
ALTER TABLE "user_network_proxies"
  ADD CONSTRAINT "user_network_proxies_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
