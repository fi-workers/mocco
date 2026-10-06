CREATE TABLE "mocco_feedback_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"author_kind" text NOT NULL,
	"author_user_id" uuid,
	"author_end_user_id" text,
	"body" text NOT NULL,
	"is_official" boolean DEFAULT false NOT NULL,
	"is_internal" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_feedback_comments_author_kind_check" CHECK ("mocco_feedback_comments"."author_kind" IN ('staff','end_user')),
	CONSTRAINT "mocco_feedback_comments_author_check" CHECK (CASE WHEN "mocco_feedback_comments"."author_kind" IN ('end_user')
        THEN "mocco_feedback_comments"."author_end_user_id" IS NOT NULL AND "mocco_feedback_comments"."author_user_id" IS NULL AND NOT "mocco_feedback_comments"."is_official" AND NOT "mocco_feedback_comments"."is_internal"
        ELSE "mocco_feedback_comments"."author_end_user_id" IS NULL END),
	CONSTRAINT "mocco_feedback_comments_visibility_check" CHECK (NOT ("mocco_feedback_comments"."is_official" AND "mocco_feedback_comments"."is_internal"))
);
--> statement-breakpoint
CREATE TABLE "mocco_feedback_votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"end_user_id" text NOT NULL,
	"state" text NOT NULL,
	"source" text NOT NULL,
	"recorded_by_user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"counted_at" timestamp,
	CONSTRAINT "mocco_feedback_votes_state_check" CHECK ("mocco_feedback_votes"."state" IN ('pending','counted')),
	CONSTRAINT "mocco_feedback_votes_source_check" CHECK ("mocco_feedback_votes"."source" IN ('web','widget','staff','intake','merge')),
	CONSTRAINT "mocco_feedback_votes_counted_check" CHECK (("mocco_feedback_votes"."state" IN ('counted')) = ("mocco_feedback_votes"."counted_at" IS NOT NULL)),
	CONSTRAINT "mocco_feedback_votes_end_user_check" CHECK (char_length("mocco_feedback_votes"."end_user_id") BETWEEN 1 AND 255)
);
--> statement-breakpoint
ALTER TABLE "mocco_feedback_posts" ADD COLUMN "vote_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mocco_feedback_posts" ADD COLUMN "comment_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mocco_feedback_comments" ADD CONSTRAINT "mocco_feedback_comments_author_user_id_mocco_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."mocco_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_feedback_comments" ADD CONSTRAINT "mocco_feedback_comments_post_fk" FOREIGN KEY ("post_id","workspace_id") REFERENCES "public"."mocco_feedback_posts"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_feedback_votes" ADD CONSTRAINT "mocco_feedback_votes_recorded_by_user_id_mocco_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."mocco_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_feedback_votes" ADD CONSTRAINT "mocco_feedback_votes_post_fk" FOREIGN KEY ("post_id","workspace_id") REFERENCES "public"."mocco_feedback_posts"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mocco_feedback_comments_post_created_idx" ON "mocco_feedback_comments" USING btree ("post_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_feedback_votes_post_end_user_uq" ON "mocco_feedback_votes" USING btree ("post_id","end_user_id");--> statement-breakpoint
CREATE INDEX "mocco_feedback_votes_post_created_idx" ON "mocco_feedback_votes" USING btree ("post_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "mocco_feedback_posts" ADD CONSTRAINT "mocco_feedback_posts_vote_count_check" CHECK ("mocco_feedback_posts"."vote_count" >= 0);--> statement-breakpoint
ALTER TABLE "mocco_feedback_posts" ADD CONSTRAINT "mocco_feedback_posts_comment_count_check" CHECK ("mocco_feedback_posts"."comment_count" >= 0);