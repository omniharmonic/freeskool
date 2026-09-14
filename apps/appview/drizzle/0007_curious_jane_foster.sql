CREATE TABLE "fs_attestation" (
	"id" text PRIMARY KEY NOT NULL,
	"attester_did" text NOT NULL,
	"subject_did" text NOT NULL,
	"skill_uri" text NOT NULL,
	"context_event_uri" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fs_skill_claim_index" (
	"did" text NOT NULL,
	"skill_uri" text NOT NULL,
	"level" text NOT NULL,
	"visibility" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fs_skill_claim_index_did_skill_uri_pk" PRIMARY KEY("did","skill_uri")
);
--> statement-breakpoint
CREATE TABLE "fs_skill_proposal" (
	"id" text PRIMARY KEY NOT NULL,
	"skill_uri" text NOT NULL,
	"proposer_did" text NOT NULL,
	"status" text DEFAULT 'published' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fs_member_prefs" ADD COLUMN "directory_listing" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "fs_member_prefs" ADD COLUMN "onboarded_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "fs_attestation_unique" ON "fs_attestation" USING btree ("attester_did","subject_did","skill_uri");--> statement-breakpoint
CREATE INDEX "fs_attestation_subject_idx" ON "fs_attestation" USING btree ("subject_did");--> statement-breakpoint
CREATE INDEX "fs_skill_claim_index_skill_idx" ON "fs_skill_claim_index" USING btree ("skill_uri");