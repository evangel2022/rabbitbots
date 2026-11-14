-- The AI company profile chosen in onboarding. Nullable so existing spaces keep their data.
ALTER TABLE "spaces" ADD COLUMN "companyName" TEXT;
ALTER TABLE "spaces" ADD COLUMN "companyDescription" TEXT;
