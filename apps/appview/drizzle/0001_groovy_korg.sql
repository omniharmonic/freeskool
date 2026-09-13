CREATE TABLE "fs_invite_link" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"inviter_did" text NOT NULL,
	"school_did" text NOT NULL,
	"event_uri" text,
	"uses_left" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"redeemed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fs_request_rsvp" (
	"request_uri" text NOT NULL,
	"did" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fs_request_rsvp_request_uri_did_pk" PRIMARY KEY("request_uri","did")
);
--> statement-breakpoint
CREATE TABLE "fs_skill_tier" (
	"skill_id" text PRIMARY KEY NOT NULL,
	"tier" text DEFAULT 'A' NOT NULL,
	"reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fs_invite_link_token_hash_idx" ON "fs_invite_link" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "fs_request_rsvp_req_idx" ON "fs_request_rsvp" USING btree ("request_uri");