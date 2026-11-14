CREATE TABLE "sandboxes" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"provider" text NOT NULL,
	"remote_id" text,
	"url" text,
	"status" text DEFAULT 'booting' NOT NULL,
	"log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"applied" jsonb,
	"results" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sandboxes_app" ON "sandboxes" USING btree ("app_id","created_at");