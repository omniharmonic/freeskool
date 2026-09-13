CREATE TABLE "fs_app_meta" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fs_attendance" (
	"id" text PRIMARY KEY NOT NULL,
	"event_uri" text NOT NULL,
	"attendee_did" text NOT NULL,
	"attested_by_did" text NOT NULL,
	"participated" boolean DEFAULT true NOT NULL,
	"role" text DEFAULT 'attendee' NOT NULL,
	"event_starts_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fs_attendance_rollup" (
	"event_uri" text PRIMARY KEY NOT NULL,
	"participated_count" integer DEFAULT 0 NOT NULL,
	"total_count" integer DEFAULT 0 NOT NULL,
	"collapsed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fs_attendance_tally" (
	"did" text PRIMARY KEY NOT NULL,
	"attended_confirmed" integer DEFAULT 0 NOT NULL,
	"hosted_events" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fs_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"caller_did" text NOT NULL,
	"school_did" text NOT NULL,
	"scope" text NOT NULL,
	"nsid" text NOT NULL,
	"action" text NOT NULL,
	"decision" text NOT NULL,
	"reason" text NOT NULL,
	"approvals" jsonb NOT NULL,
	"policy_source" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fs_custodial_account" (
	"did" text PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"email" text NOT NULL,
	"is_custodial" boolean DEFAULT true NOT NULL,
	"key_version" text NOT NULL,
	"wrapped_password" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	"owned_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fs_email_verification" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"did" text NOT NULL,
	"purpose" text DEFAULT 'verify-email' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fs_feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"event_uri" text NOT NULL,
	"host_did" text NOT NULL,
	"direction" text NOT NULL,
	"aspects" jsonb,
	"text" text,
	"day" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fs_feedback_ballot" (
	"event_uri" text NOT NULL,
	"ballot" text NOT NULL,
	"cast_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fs_feedback_ballot_event_uri_ballot_pk" PRIMARY KEY("event_uri","ballot")
);
--> statement-breakpoint
CREATE TABLE "fs_feedback_window" (
	"event_uri" text PRIMARY KEY NOT NULL,
	"opens_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closes_at" timestamp with time zone NOT NULL,
	"ballot_key" "bytea",
	"key_destroyed_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"summary" jsonb
);
--> statement-breakpoint
CREATE TABLE "fs_invite" (
	"code" text PRIMARY KEY NOT NULL,
	"inviter_did" text,
	"used_by_did" text,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"inviter_purged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fs_moderation_queue" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_uri" text,
	"subject_did" text,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"approvals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"opened_by_did" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"result_uri" text
);
--> statement-breakpoint
CREATE TABLE "fs_newsletter" (
	"id" text PRIMARY KEY NOT NULL,
	"period" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fs_notification_feed" (
	"id" text PRIMARY KEY NOT NULL,
	"did" text NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"navigate" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fs_notification_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"did" text NOT NULL,
	"category" text NOT NULL,
	"dedup_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"failure_code" text
);
--> statement-breakpoint
CREATE TABLE "fs_notification_pref" (
	"did" text NOT NULL,
	"category" text NOT NULL,
	"transport" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "fs_notification_pref_did_category_transport_pk" PRIMARY KEY("did","category","transport")
);
--> statement-breakpoint
CREATE TABLE "fs_notification_sent" (
	"dedup_key" text PRIMARY KEY NOT NULL,
	"did" text NOT NULL,
	"category" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fs_notification_target" (
	"id" text PRIMARY KEY NOT NULL,
	"did" text NOT NULL,
	"transport" text NOT NULL,
	"address" text NOT NULL,
	"keys" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fs_oauth_client_key" (
	"kid" text PRIMARY KEY NOT NULL,
	"jwk" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fs_oauth_session" (
	"sub" text PRIMARY KEY NOT NULL,
	"session" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fs_oauth_state" (
	"key" text PRIMARY KEY NOT NULL,
	"state" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fs_peer" (
	"host" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"school_did" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fs_policy_cache" (
	"school_did" text PRIMARY KEY NOT NULL,
	"policy_uri" text,
	"thresholds" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fs_rsvp" (
	"id" text PRIMARY KEY NOT NULL,
	"event_uri" text NOT NULL,
	"did" text NOT NULL,
	"status" text NOT NULL,
	"also_public_record" boolean DEFAULT false NOT NULL,
	"public_record_uri" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fs_series_occurrence" (
	"series_uri" text NOT NULL,
	"occurrence_rkey" text NOT NULL,
	"original_starts_at" timestamp with time zone NOT NULL,
	"event_uri" text,
	"sequence" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fs_series_occurrence_series_uri_occurrence_rkey_pk" PRIMARY KEY("series_uri","occurrence_rkey")
);
--> statement-breakpoint
CREATE TABLE "fs_session" (
	"id" text PRIMARY KEY NOT NULL,
	"did" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fs_space" (
	"uri" text PRIMARY KEY NOT NULL,
	"authority" text NOT NULL,
	"space_type" text NOT NULL,
	"skey" text NOT NULL,
	"policy" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fs_space_member" (
	"space_uri" text NOT NULL,
	"did" text NOT NULL,
	"role" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fs_space_member_space_uri_did_pk" PRIMARY KEY("space_uri","did")
);
--> statement-breakpoint
CREATE TABLE "fs_space_record" (
	"uri" text PRIMARY KEY NOT NULL,
	"space_uri" text NOT NULL,
	"author" text NOT NULL,
	"collection" text NOT NULL,
	"rkey" text NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fs_steward" (
	"did" text PRIMARY KEY NOT NULL,
	"school_did" text NOT NULL,
	"appointed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"appointed_by_did" text,
	"suspended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fs_attendance_event_attendee_idx" ON "fs_attendance" USING btree ("event_uri","attendee_did");--> statement-breakpoint
CREATE INDEX "fs_attendance_attendee_idx" ON "fs_attendance" USING btree ("attendee_did");--> statement-breakpoint
CREATE INDEX "fs_audit_at_idx" ON "fs_audit" USING btree ("at");--> statement-breakpoint
CREATE INDEX "fs_audit_action_idx" ON "fs_audit" USING btree ("action");--> statement-breakpoint
CREATE UNIQUE INDEX "fs_custodial_handle_idx" ON "fs_custodial_account" USING btree ("handle");--> statement-breakpoint
CREATE INDEX "fs_email_verification_did_idx" ON "fs_email_verification" USING btree ("did");--> statement-breakpoint
CREATE INDEX "fs_feedback_event_idx" ON "fs_feedback" USING btree ("event_uri");--> statement-breakpoint
CREATE INDEX "fs_feedback_host_idx" ON "fs_feedback" USING btree ("host_did");--> statement-breakpoint
CREATE INDEX "fs_invite_used_by_idx" ON "fs_invite" USING btree ("used_by_did");--> statement-breakpoint
CREATE INDEX "fs_moderation_status_idx" ON "fs_moderation_queue" USING btree ("status");--> statement-breakpoint
CREATE INDEX "fs_notification_feed_did_idx" ON "fs_notification_feed" USING btree ("did","created_at");--> statement-breakpoint
CREATE INDEX "fs_notification_outbox_due_idx" ON "fs_notification_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "fs_notification_outbox_did_idx" ON "fs_notification_outbox" USING btree ("did");--> statement-breakpoint
CREATE INDEX "fs_notification_sent_did_idx" ON "fs_notification_sent" USING btree ("did");--> statement-breakpoint
CREATE UNIQUE INDEX "fs_notification_target_addr_idx" ON "fs_notification_target" USING btree ("did","transport","address");--> statement-breakpoint
CREATE INDEX "fs_notification_target_did_idx" ON "fs_notification_target" USING btree ("did");--> statement-breakpoint
CREATE UNIQUE INDEX "fs_rsvp_event_did_idx" ON "fs_rsvp" USING btree ("event_uri","did");--> statement-breakpoint
CREATE INDEX "fs_rsvp_did_idx" ON "fs_rsvp" USING btree ("did");--> statement-breakpoint
CREATE INDEX "fs_session_did_idx" ON "fs_session" USING btree ("did");--> statement-breakpoint
CREATE INDEX "fs_session_expires_idx" ON "fs_session" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "fs_space_record_lookup_idx" ON "fs_space_record" USING btree ("space_uri","collection");