CREATE TABLE "mocco_messenger_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"external_user_id" text NOT NULL,
	"name" text,
	"email" text,
	"traits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_seen_at" timestamp NOT NULL,
	"blocked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_messenger_contacts_id_workspace_uq" UNIQUE("id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "mocco_messenger_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"status" text NOT NULL,
	"category" text,
	"last_message_seq" integer DEFAULT 0 NOT NULL,
	"last_message_at" timestamp NOT NULL,
	"last_operator_seq" integer DEFAULT 0 NOT NULL,
	"contact_last_read_seq" integer DEFAULT 0 NOT NULL,
	"preview" text NOT NULL,
	"context_at_open" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"closed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_messenger_conversations_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "mocco_messenger_conversations_status_check" CHECK ("mocco_messenger_conversations"."status" IN ('open','closed'))
);
--> statement-breakpoint
CREATE TABLE "mocco_messenger_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"author_kind" text NOT NULL,
	"author_user_id" uuid,
	"visibility" text NOT NULL,
	"body" text NOT NULL,
	"client_message_id" text,
	"context" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_messenger_messages_author_check" CHECK ("mocco_messenger_messages"."author_kind" IN ('contact','operator','system')),
	CONSTRAINT "mocco_messenger_messages_visibility_check" CHECK ("mocco_messenger_messages"."visibility" IN ('public','internal')),
	CONSTRAINT "mocco_messenger_messages_internal_check" CHECK ("mocco_messenger_messages"."visibility" = 'public' OR "mocco_messenger_messages"."author_kind" = 'operator')
);
--> statement-breakpoint
CREATE TABLE "mocco_messenger_operator_reads" (
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"last_read_seq" integer NOT NULL,
	CONSTRAINT "mocco_messenger_operator_reads_pk" PRIMARY KEY("conversation_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "mocco_messenger_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mocco_messenger_settings" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"identity_secret_sealed" text NOT NULL,
	"categories" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mocco_messenger_contacts" ADD CONSTRAINT "mocco_messenger_contacts_project_fk" FOREIGN KEY ("project_id","workspace_id") REFERENCES "public"."mocco_projects"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_messenger_conversations" ADD CONSTRAINT "mocco_messenger_conversations_contact_fk" FOREIGN KEY ("contact_id","workspace_id") REFERENCES "public"."mocco_messenger_contacts"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_messenger_messages" ADD CONSTRAINT "mocco_messenger_messages_author_user_id_mocco_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."mocco_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_messenger_messages" ADD CONSTRAINT "mocco_messenger_messages_conversation_fk" FOREIGN KEY ("conversation_id","workspace_id") REFERENCES "public"."mocco_messenger_conversations"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_messenger_operator_reads" ADD CONSTRAINT "mocco_messenger_operator_reads_user_id_mocco_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."mocco_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_messenger_operator_reads" ADD CONSTRAINT "mocco_messenger_operator_reads_conversation_fk" FOREIGN KEY ("conversation_id","workspace_id") REFERENCES "public"."mocco_messenger_conversations"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_messenger_sessions" ADD CONSTRAINT "mocco_messenger_sessions_contact_fk" FOREIGN KEY ("contact_id","workspace_id") REFERENCES "public"."mocco_messenger_contacts"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_messenger_settings" ADD CONSTRAINT "mocco_messenger_settings_project_fk" FOREIGN KEY ("project_id","workspace_id") REFERENCES "public"."mocco_projects"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_messenger_contacts_project_user_uq" ON "mocco_messenger_contacts" USING btree ("project_id","external_user_id");--> statement-breakpoint
CREATE INDEX "mocco_messenger_conversations_inbox_idx" ON "mocco_messenger_conversations" USING btree ("workspace_id","project_id","status","last_message_at");--> statement-breakpoint
CREATE INDEX "mocco_messenger_conversations_contact_idx" ON "mocco_messenger_conversations" USING btree ("contact_id","last_message_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_messenger_messages_conversation_seq_uq" ON "mocco_messenger_messages" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_messenger_messages_conversation_client_uq" ON "mocco_messenger_messages" USING btree ("conversation_id","client_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_messenger_sessions_token_uq" ON "mocco_messenger_sessions" USING btree ("token_hash");