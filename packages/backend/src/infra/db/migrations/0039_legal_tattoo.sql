CREATE TABLE "mocco_messenger_push_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"token" text NOT NULL,
	"platform" text NOT NULL,
	"last_seen_at" timestamp NOT NULL,
	"disabled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mocco_messenger_push_tokens" ADD CONSTRAINT "mocco_messenger_push_tokens_contact_fk" FOREIGN KEY ("contact_id","workspace_id") REFERENCES "public"."mocco_messenger_contacts"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_messenger_push_tokens_project_token_uq" ON "mocco_messenger_push_tokens" USING btree ("project_id","token");--> statement-breakpoint
CREATE INDEX "mocco_messenger_push_tokens_contact_idx" ON "mocco_messenger_push_tokens" USING btree ("contact_id");