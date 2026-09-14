-- Federation Task 3: the primary keys and unique index that MAKE tenancy true.
--
-- Every one of these was deferred by Task 2 because it needs the write path changed in
-- the same commit (a widened ON CONFLICT target is a runtime error against the old key,
-- and vice versa). MS §4:
--
--   fs_attendance_tally  (did) -> (did, school_did)   a global tally would make Boulder
--                                                     attendance grant Denver hosting
--   fs_steward           (did) -> (did, school_did)   `did` alone forbade being a steward
--                                                     of two schools
--   fs_newsletter_subscription (did) -> (did, school_did)
--   fs_peer              (host) -> (school_did, host) each school picks its own peers
--   fs_attestation       unique (attester, subject, skill) -> + school_did
--
-- Safe against rows the backfill has already stamped and rows it has not: `school_did`
-- is NOT NULL DEFAULT '' everywhere, and '' reads as "the legacy school"
-- (lib/school-scope.ts). The only column that changes nullability is `fs_peer.school_did`,
-- whose NULLs are filled with '' first.

ALTER TABLE "fs_attendance_tally" DROP CONSTRAINT IF EXISTS "fs_attendance_tally_pkey";--> statement-breakpoint
ALTER TABLE "fs_attendance_tally" ADD CONSTRAINT "fs_attendance_tally_did_school_did_pk" PRIMARY KEY("did","school_did");--> statement-breakpoint

ALTER TABLE "fs_steward" DROP CONSTRAINT IF EXISTS "fs_steward_pkey";--> statement-breakpoint
ALTER TABLE "fs_steward" ADD CONSTRAINT "fs_steward_did_school_did_pk" PRIMARY KEY("did","school_did");--> statement-breakpoint

ALTER TABLE "fs_newsletter_subscription" DROP CONSTRAINT IF EXISTS "fs_newsletter_subscription_pkey";--> statement-breakpoint
ALTER TABLE "fs_newsletter_subscription" ADD CONSTRAINT "fs_newsletter_subscription_did_school_did_pk" PRIMARY KEY("did","school_did");--> statement-breakpoint

UPDATE "fs_peer" SET "school_did" = '' WHERE "school_did" IS NULL;--> statement-breakpoint
ALTER TABLE "fs_peer" ALTER COLUMN "school_did" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "fs_peer" ALTER COLUMN "school_did" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "fs_peer" DROP CONSTRAINT IF EXISTS "fs_peer_pkey";--> statement-breakpoint
ALTER TABLE "fs_peer" ADD CONSTRAINT "fs_peer_school_did_host_pk" PRIMARY KEY("school_did","host");--> statement-breakpoint
CREATE INDEX "fs_peer_host_idx" ON "fs_peer" USING btree ("host");--> statement-breakpoint

DROP INDEX IF EXISTS "fs_attestation_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "fs_attestation_unique" ON "fs_attestation" USING btree ("attester_did","subject_did","skill_uri","school_did");
