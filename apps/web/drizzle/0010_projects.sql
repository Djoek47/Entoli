CREATE TABLE "project_files" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"path" text NOT NULL,
	"content" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "origin" jsonb;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "role" text DEFAULT 'new' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_files" ADD CONSTRAINT "project_files_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_files_path" ON "project_files" USING btree ("app_id","path");