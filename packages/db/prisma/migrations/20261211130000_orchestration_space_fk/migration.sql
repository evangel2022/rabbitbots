-- Deleting a space removes its orchestration rows and, by cascade, their children.
ALTER TABLE "orchestrations" ADD CONSTRAINT "orchestrations_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
