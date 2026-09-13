CREATE TABLE "fs_event_extra" (
	"event_uri" text PRIMARY KEY NOT NULL,
	"materials" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"supplies_note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fs_ownership_reveal" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"did" text NOT NULL,
	"key_version" text NOT NULL,
	"wrapped_password" "bytea",
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "fs_ownership_reveal_did_idx" ON "fs_ownership_reveal" USING btree ("did");