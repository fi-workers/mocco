CREATE TABLE "mocco_messenger_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"message_id" uuid,
	"object_id" uuid NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mocco_messenger_attachments" ADD CONSTRAINT "mocco_messenger_attachments_message_id_mocco_messenger_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."mocco_messenger_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_messenger_attachments" ADD CONSTRAINT "mocco_messenger_attachments_object_id_mocco_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."mocco_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_messenger_attachments" ADD CONSTRAINT "mocco_messenger_attachments_contact_fk" FOREIGN KEY ("contact_id","workspace_id") REFERENCES "public"."mocco_messenger_contacts"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mocco_messenger_attachments_message_idx" ON "mocco_messenger_attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "mocco_messenger_attachments_contact_idx" ON "mocco_messenger_attachments" USING btree ("contact_id","created_at");