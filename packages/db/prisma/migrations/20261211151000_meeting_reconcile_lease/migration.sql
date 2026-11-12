-- Serialize worker reconciliation for a meeting; expired leases are reclaimable.
ALTER TABLE "meetings" ADD COLUMN "reconcileLeaseUntil" TIMESTAMP(3);
