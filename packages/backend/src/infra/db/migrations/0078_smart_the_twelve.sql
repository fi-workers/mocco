CREATE TABLE "mocco_feedback_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"end_user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"unsubscribed_at" timestamp,
	CONSTRAINT "mocco_feedback_subscriptions_end_user_check" CHECK (char_length("mocco_feedback_subscriptions"."end_user_id") BETWEEN 1 AND 255)
);
--> statement-breakpoint
ALTER TABLE "mocco_feedback_posts" ADD COLUMN "merged_into_post_id" uuid;--> statement-breakpoint
ALTER TABLE "mocco_feedback_posts" ADD COLUMN "merged_at" timestamp;--> statement-breakpoint
ALTER TABLE "mocco_feedback_subscriptions" ADD CONSTRAINT "mocco_feedback_subscriptions_post_fk" FOREIGN KEY ("post_id","workspace_id") REFERENCES "public"."mocco_feedback_posts"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_feedback_subscriptions_post_end_user_uq" ON "mocco_feedback_subscriptions" USING btree ("post_id","end_user_id");--> statement-breakpoint
ALTER TABLE "mocco_feedback_posts" ADD CONSTRAINT "mocco_feedback_posts_merged_into_fk" FOREIGN KEY ("merged_into_post_id","workspace_id") REFERENCES "public"."mocco_feedback_posts"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mocco_feedback_posts_merged_into_idx" ON "mocco_feedback_posts" USING btree ("merged_into_post_id") WHERE "mocco_feedback_posts"."merged_into_post_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "mocco_feedback_posts" ADD CONSTRAINT "mocco_feedback_posts_merged_check" CHECK (("mocco_feedback_posts"."merged_into_post_id" IS NULL) = ("mocco_feedback_posts"."merged_at" IS NULL) AND "mocco_feedback_posts"."merged_into_post_id" IS DISTINCT FROM "mocco_feedback_posts"."id");