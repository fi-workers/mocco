CREATE TABLE "mocco_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_members_role_check" CHECK ("mocco_members"."role" in ('owner', 'admin', 'member'))
);
--> statement-breakpoint
CREATE TABLE "mocco_workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_workspaces_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "mocco_sessions" ADD COLUMN "active_workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "mocco_members" ADD CONSTRAINT "mocco_members_workspace_id_mocco_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."mocco_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_members" ADD CONSTRAINT "mocco_members_user_id_mocco_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."mocco_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_members_workspace_user_uq" ON "mocco_members" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "mocco_members_user_id_idx" ON "mocco_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_workspaces_slug_lower_uq" ON "mocco_workspaces" USING btree (lower("slug"));--> statement-breakpoint
ALTER TABLE "mocco_sessions" ADD CONSTRAINT "mocco_sessions_active_workspace_id_mocco_workspaces_id_fk" FOREIGN KEY ("active_workspace_id") REFERENCES "public"."mocco_workspaces"("id") ON DELETE set null ON UPDATE no action;