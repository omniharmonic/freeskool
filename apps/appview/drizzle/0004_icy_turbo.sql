CREATE TABLE "fs_handoff" (
	"id" text PRIMARY KEY NOT NULL,
	"from_did" text NOT NULL,
	"to_did" text,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fs_member_prefs" (
	"did" text PRIMARY KEY NOT NULL,
	"public_role" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fs_newsletter_issue" (
	"id" text PRIMARY KEY NOT NULL,
	"month" text NOT NULL,
	"html" text NOT NULL,
	"text" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"sent_at" timestamp with time zone,
	"recipient_count" integer
);
--> statement-breakpoint
CREATE TABLE "fs_newsletter_subscription" (
	"did" text PRIMARY KEY NOT NULL,
	"email_ref" text NOT NULL,
	"subscribed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unsubscribed_at" timestamp with time zone,
	"token_hash" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fs_handoff_token_idx" ON "fs_handoff" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "fs_newsletter_subscription_token_idx" ON "fs_newsletter_subscription" USING btree ("token_hash");