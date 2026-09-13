CREATE TABLE "fs_member" (
	"did" text PRIMARY KEY NOT NULL,
	"door" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
