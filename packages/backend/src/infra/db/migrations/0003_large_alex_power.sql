CREATE TABLE "mocco_github_connect_states" (
	"state" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"github_user_login" text,
	"github_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "mocco_provider_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_account_id" text NOT NULL,
	"account_login" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_provider_connections_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "mocco_provider_connections_provider_check" CHECK ("mocco_provider_connections"."provider" IN ('github')),
	CONSTRAINT "mocco_provider_connections_status_check" CHECK ("mocco_provider_connections"."status" IN ('active','suspended','deleted'))
);
--> statement-breakpoint
CREATE TABLE "mocco_repos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"external_repo_id" text NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"default_branch" text NOT NULL,
	"watched_branch" text,
	"status" text DEFAULT 'active' NOT NULL,
	"connected_at" timestamp DEFAULT now() NOT NULL,
	"last_synced_at" timestamp,
	CONSTRAINT "mocco_repos_status_check" CHECK ("mocco_repos"."status" IN ('active','inactive'))
);
--> statement-breakpoint
ALTER TABLE "mocco_github_connect_states" ADD CONSTRAINT "mocco_github_connect_states_workspace_id_mocco_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."mocco_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_provider_connections" ADD CONSTRAINT "mocco_provider_connections_workspace_id_mocco_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."mocco_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_repos" ADD CONSTRAINT "mocco_repos_connection_id_mocco_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mocco_provider_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_repos" ADD CONSTRAINT "mocco_repos_connection_workspace_fk" FOREIGN KEY ("connection_id","workspace_id") REFERENCES "public"."mocco_provider_connections"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mocco_github_connect_states_workspace_idx" ON "mocco_github_connect_states" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_provider_connections_provider_account_uq" ON "mocco_provider_connections" USING btree ("provider","external_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_repos_connection_repo_uq" ON "mocco_repos" USING btree ("connection_id","external_repo_id");