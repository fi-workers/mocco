ALTER TABLE "mocco_messenger_contacts" ALTER COLUMN "external_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mocco_messenger_contacts" ADD COLUMN "guest_token_hash" text;--> statement-breakpoint
ALTER TABLE "mocco_messenger_settings" ADD COLUMN "allow_guests" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_messenger_contacts_guest_token_uq" ON "mocco_messenger_contacts" USING btree ("guest_token_hash");--> statement-breakpoint
ALTER TABLE "mocco_messenger_contacts" ADD CONSTRAINT "mocco_messenger_contacts_identity_check" CHECK ("mocco_messenger_contacts"."external_user_id" IS NOT NULL OR ("mocco_messenger_contacts"."email" IS NOT NULL AND "mocco_messenger_contacts"."guest_token_hash" IS NOT NULL));