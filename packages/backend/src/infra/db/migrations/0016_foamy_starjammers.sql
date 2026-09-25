CREATE TABLE "mocco_discord_connect_states" (
	"state" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "mocco_discord_guilds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"guild_id" text NOT NULL,
	"guild_name" text NOT NULL,
	"installed_by_user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mocco_discord_connect_states" ADD CONSTRAINT "mocco_discord_connect_states_workspace_id_mocco_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."mocco_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_discord_guilds" ADD CONSTRAINT "mocco_discord_guilds_workspace_id_mocco_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."mocco_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_discord_guilds" ADD CONSTRAINT "mocco_discord_guilds_installed_by_user_id_mocco_users_id_fk" FOREIGN KEY ("installed_by_user_id") REFERENCES "public"."mocco_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mocco_discord_connect_states_workspace_idx" ON "mocco_discord_connect_states" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_discord_guilds_workspace_guild_uq" ON "mocco_discord_guilds" USING btree ("workspace_id","guild_id");