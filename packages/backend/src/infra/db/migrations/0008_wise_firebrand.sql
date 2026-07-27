CREATE TABLE "mocco_role_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mocco_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mocco_role_memberships" ADD CONSTRAINT "mocco_role_memberships_workspace_id_mocco_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."mocco_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_role_memberships" ADD CONSTRAINT "mocco_role_memberships_role_id_mocco_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."mocco_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_role_memberships" ADD CONSTRAINT "mocco_role_memberships_user_id_mocco_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."mocco_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_roles" ADD CONSTRAINT "mocco_roles_workspace_id_mocco_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."mocco_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_role_memberships_role_user_uq" ON "mocco_role_memberships" USING btree ("role_id","user_id");--> statement-breakpoint
CREATE INDEX "mocco_role_memberships_user_id_idx" ON "mocco_role_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_roles_workspace_name_uq" ON "mocco_roles" USING btree ("workspace_id","name");