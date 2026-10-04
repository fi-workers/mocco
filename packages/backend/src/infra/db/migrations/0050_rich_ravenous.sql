CREATE TABLE "mocco_mcp_settings" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"agents_may_decide" boolean DEFAULT false NOT NULL,
	"changed_at" timestamp DEFAULT now() NOT NULL,
	"changed_by_user_id" uuid
);
--> statement-breakpoint
ALTER TABLE "mocco_mcp_settings" ADD CONSTRAINT "mocco_mcp_settings_workspace_id_mocco_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."mocco_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_mcp_settings" ADD CONSTRAINT "mocco_mcp_settings_changed_by_user_id_mocco_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."mocco_users"("id") ON DELETE set null ON UPDATE no action;