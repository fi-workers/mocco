ALTER TABLE "mocco_repos" ADD CONSTRAINT "mocco_repos_id_workspace_uq" UNIQUE("id","workspace_id");--> statement-breakpoint
CREATE TABLE "mocco_project_apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"name" text NOT NULL,
	"bundle_id" text,
	"store_app_id" text,
	"web_origins" text[],
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_project_apps_platform_check" CHECK ("mocco_project_apps"."platform" IN ('ios','android','web','react_native','server'))
);
--> statement-breakpoint
CREATE TABLE "mocco_project_repos" (
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_project_repos_pk" PRIMARY KEY("project_id","repo_id")
);
--> statement-breakpoint
CREATE TABLE "mocco_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"handle" text NOT NULL,
	"default_locale" text DEFAULT 'en' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"archived_at" timestamp,
	CONSTRAINT "mocco_projects_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "mocco_projects_handle_check" CHECK ("mocco_projects"."handle" ~ '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$')
);
--> statement-breakpoint
CREATE TABLE "mocco_workspace_products" (
	"workspace_id" uuid NOT NULL,
	"product" text NOT NULL,
	"enabled_at" timestamp DEFAULT now() NOT NULL,
	"enabled_by_user_id" uuid,
	CONSTRAINT "mocco_workspace_products_pk" PRIMARY KEY("workspace_id","product"),
	CONSTRAINT "mocco_workspace_products_product_check" CHECK ("mocco_workspace_products"."product" IN ('ota','flags','status','reviews','feedback','messenger','helpcenter','forum','links','identity'))
);
--> statement-breakpoint
ALTER TABLE "mocco_project_apps" ADD CONSTRAINT "mocco_project_apps_project_workspace_fk" FOREIGN KEY ("project_id","workspace_id") REFERENCES "public"."mocco_projects"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_project_repos" ADD CONSTRAINT "mocco_project_repos_project_workspace_fk" FOREIGN KEY ("project_id","workspace_id") REFERENCES "public"."mocco_projects"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_project_repos" ADD CONSTRAINT "mocco_project_repos_repo_workspace_fk" FOREIGN KEY ("repo_id","workspace_id") REFERENCES "public"."mocco_repos"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_projects" ADD CONSTRAINT "mocco_projects_workspace_id_mocco_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."mocco_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_workspace_products" ADD CONSTRAINT "mocco_workspace_products_workspace_id_mocco_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."mocco_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_workspace_products" ADD CONSTRAINT "mocco_workspace_products_enabled_by_user_id_mocco_users_id_fk" FOREIGN KEY ("enabled_by_user_id") REFERENCES "public"."mocco_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mocco_project_apps_project_idx" ON "mocco_project_apps" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_project_apps_project_platform_bundle_uq" ON "mocco_project_apps" USING btree ("project_id","platform","bundle_id") WHERE "mocco_project_apps"."bundle_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "mocco_project_repos_repo_idx" ON "mocco_project_repos" USING btree ("repo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_projects_workspace_handle_uq" ON "mocco_projects" USING btree ("workspace_id","handle");
