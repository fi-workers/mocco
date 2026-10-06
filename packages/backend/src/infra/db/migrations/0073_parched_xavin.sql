CREATE TABLE "mocco_messenger_inbox_members" (
	"project_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"available" boolean DEFAULT true NOT NULL,
	"last_turn" integer DEFAULT 0 NOT NULL,
	"last_assigned_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_messenger_inbox_members_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "mocco_messenger_conversations" ADD COLUMN "assignee_user_id" uuid;--> statement-breakpoint
ALTER TABLE "mocco_messenger_inbox_members" ADD CONSTRAINT "mocco_messenger_inbox_members_user_id_mocco_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."mocco_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_messenger_inbox_members" ADD CONSTRAINT "mocco_messenger_inbox_members_project_fk" FOREIGN KEY ("project_id","workspace_id") REFERENCES "public"."mocco_projects"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_messenger_conversations" ADD CONSTRAINT "mocco_messenger_conversations_assignee_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."mocco_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mocco_messenger_conversations_assignee_idx" ON "mocco_messenger_conversations" USING btree ("assignee_user_id","status");