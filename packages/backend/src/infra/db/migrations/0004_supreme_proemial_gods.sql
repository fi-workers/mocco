CREATE TABLE "mocco_commits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"seq" bigserial NOT NULL,
	"sha" text NOT NULL,
	"branch" text NOT NULL,
	"message" text NOT NULL,
	"author_name" text NOT NULL,
	"author_email" text NOT NULL,
	"committed_at" timestamp NOT NULL,
	"synced_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mocco_webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"delivery_id" text NOT NULL,
	"event_type" text NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_webhook_deliveries_provider_check" CHECK ("mocco_webhook_deliveries"."provider" IN ('github'))
);
--> statement-breakpoint
ALTER TABLE "mocco_commits" ADD CONSTRAINT "mocco_commits_repo_id_mocco_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."mocco_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_commits_repo_sha_uq" ON "mocco_commits" USING btree ("repo_id","sha");--> statement-breakpoint
CREATE INDEX "mocco_commits_repo_seq_idx" ON "mocco_commits" USING btree ("repo_id","seq" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_webhook_deliveries_delivery_uq" ON "mocco_webhook_deliveries" USING btree ("delivery_id");