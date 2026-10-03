CREATE TABLE "mocco_flag_code_scans" (
	"workspace_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"commit_sha" text NOT NULL,
	"scanned_keys" text[] NOT NULL,
	"found_keys" text[] NOT NULL,
	"is_complete" boolean NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_flag_code_scans_pk" PRIMARY KEY("repo_id","commit_sha")
);
--> statement-breakpoint
ALTER TABLE "mocco_flag_code_scans" ADD CONSTRAINT "mocco_flag_code_scans_repo_id_mocco_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."mocco_repos"("id") ON DELETE cascade ON UPDATE no action;