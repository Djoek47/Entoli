CREATE TABLE "agent_events" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"kind" text NOT NULL,
	"act" text,
	"status" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"label" text DEFAULT 'agent' NOT NULL,
	"prefix" text NOT NULL,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_events_app" ON "agent_events" USING btree ("app_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_tokens_hash" ON "mcp_tokens" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "mcp_tokens_app" ON "mcp_tokens" USING btree ("app_id");