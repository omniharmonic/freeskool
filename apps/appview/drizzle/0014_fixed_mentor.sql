ALTER TABLE "fs_school" ADD COLUMN "pds_url" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "fs_school" ADD COLUMN "custody" text DEFAULT 'app' NOT NULL;--> statement-breakpoint
ALTER TABLE "fs_school" ADD COLUMN "created_by_did" text;--> statement-breakpoint
ALTER TABLE "fs_school_credential" ADD COLUMN "identifier" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "fs_school_credential" ADD COLUMN "last_ok_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fs_school_credential" ADD COLUMN "last_error_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fs_school_domain" ADD COLUMN "verified_at" timestamp with time zone;