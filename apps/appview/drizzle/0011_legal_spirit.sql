CREATE TABLE "fs_event_school" (
	"event_uri" text PRIMARY KEY NOT NULL,
	"school_did" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fs_membership" (
	"did" text NOT NULL,
	"school_did" text NOT NULL,
	"door" text NOT NULL,
	"directory_listing" boolean DEFAULT true NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	CONSTRAINT "fs_membership_did_school_did_pk" PRIMARY KEY("did","school_did")
);
--> statement-breakpoint
CREATE TABLE "fs_school" (
	"did" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"name" text NOT NULL,
	"city" text,
	"handle" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"creation_state" text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fs_school_credential" (
	"school_did" text PRIMARY KEY NOT NULL,
	"key_version" text NOT NULL,
	"app_password_wrapped" "bytea",
	"rotated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fs_school_domain" (
	"host" text PRIMARY KEY NOT NULL,
	"school_did" text NOT NULL,
	"kind" text DEFAULT 'alias' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fs_attendance" ADD COLUMN "school_did" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "fs_attendance_rollup" ADD COLUMN "school_did" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "fs_attendance_tally" ADD COLUMN "school_did" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "fs_attestation" ADD COLUMN "school_did" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "fs_feedback" ADD COLUMN "school_did" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "fs_handoff" ADD COLUMN "school_did" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "fs_invite" ADD COLUMN "school_did" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "fs_moderation_queue" ADD COLUMN "school_did" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "fs_newsletter_issue" ADD COLUMN "school_did" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "fs_newsletter_subscription" ADD COLUMN "school_did" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "fs_notification_feed" ADD COLUMN "school_did" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "fs_notification_outbox" ADD COLUMN "school_did" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "fs_notification_sent" ADD COLUMN "school_did" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "fs_request_rsvp" ADD COLUMN "school_did" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "fs_rsvp" ADD COLUMN "school_did" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "fs_session" ADD COLUMN "current_school_did" text;--> statement-breakpoint
ALTER TABLE "fs_skill_proposal" ADD COLUMN "school_did" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX "fs_event_school_school_idx" ON "fs_event_school" USING btree ("school_did");--> statement-breakpoint
CREATE INDEX "fs_membership_school_idx" ON "fs_membership" USING btree ("school_did","last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fs_school_label_idx" ON "fs_school" USING btree ("label");--> statement-breakpoint
CREATE INDEX "fs_school_domain_school_idx" ON "fs_school_domain" USING btree ("school_did");--> statement-breakpoint
CREATE INDEX "fs_audit_school_at_idx" ON "fs_audit" USING btree ("school_did","at");--> statement-breakpoint
CREATE INDEX "fs_moderation_school_status_idx" ON "fs_moderation_queue" USING btree ("school_did","status");