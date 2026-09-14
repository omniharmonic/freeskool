CREATE TABLE "fs_request_asked_of" (
	"request_uri" text PRIMARY KEY NOT NULL,
	"asked_of_did" text NOT NULL,
	"school_did" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "fs_request_asked_of_did_idx" ON "fs_request_asked_of" USING btree ("asked_of_did");