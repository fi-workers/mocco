CREATE TABLE "mocco_feedback_duplicate_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"board_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"candidate_post_id" uuid NOT NULL,
	"score" real NOT NULL,
	"method" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"dismissed_at" timestamp,
	"dismissed_by_user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_feedback_duplicate_candidates_distinct_check" CHECK ("mocco_feedback_duplicate_candidates"."post_id" <> "mocco_feedback_duplicate_candidates"."candidate_post_id"),
	CONSTRAINT "mocco_feedback_duplicate_candidates_score_check" CHECK ("mocco_feedback_duplicate_candidates"."score" >= 0 AND "mocco_feedback_duplicate_candidates"."score" <= 1),
	CONSTRAINT "mocco_feedback_duplicate_candidates_method_check" CHECK ("mocco_feedback_duplicate_candidates"."method" IN ('fulltext')),
	CONSTRAINT "mocco_feedback_duplicate_candidates_state_check" CHECK ("mocco_feedback_duplicate_candidates"."state" IN ('open','dismissed')),
	CONSTRAINT "mocco_feedback_duplicate_candidates_dismissed_check" CHECK (("mocco_feedback_duplicate_candidates"."state" = 'dismissed') = ("mocco_feedback_duplicate_candidates"."dismissed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "mocco_feedback_posts" ADD COLUMN "duplicates_checked_at" timestamp;--> statement-breakpoint
ALTER TABLE "mocco_feedback_duplicate_candidates" ADD CONSTRAINT "mocco_feedback_duplicate_candidates_dismissed_by_user_id_mocco_users_id_fk" FOREIGN KEY ("dismissed_by_user_id") REFERENCES "public"."mocco_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_feedback_duplicate_candidates" ADD CONSTRAINT "mocco_feedback_duplicate_candidates_board_fk" FOREIGN KEY ("board_id","workspace_id","project_id") REFERENCES "public"."mocco_feedback_boards"("id","workspace_id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_feedback_duplicate_candidates" ADD CONSTRAINT "mocco_feedback_duplicate_candidates_post_fk" FOREIGN KEY ("post_id","workspace_id") REFERENCES "public"."mocco_feedback_posts"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_feedback_duplicate_candidates" ADD CONSTRAINT "mocco_feedback_duplicate_candidates_candidate_fk" FOREIGN KEY ("candidate_post_id","workspace_id") REFERENCES "public"."mocco_feedback_posts"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_feedback_duplicate_candidates_pair_uq" ON "mocco_feedback_duplicate_candidates" USING btree ("post_id","candidate_post_id");--> statement-breakpoint
CREATE INDEX "mocco_feedback_duplicate_candidates_board_open_idx" ON "mocco_feedback_duplicate_candidates" USING btree ("board_id","created_at" DESC NULLS LAST) WHERE "mocco_feedback_duplicate_candidates"."state" = 'open';--> statement-breakpoint
CREATE INDEX "mocco_feedback_duplicate_candidates_candidate_idx" ON "mocco_feedback_duplicate_candidates" USING btree ("candidate_post_id");--> statement-breakpoint
CREATE INDEX "mocco_feedback_posts_duplicates_unchecked_idx" ON "mocco_feedback_posts" USING btree ("created_at") WHERE "mocco_feedback_posts"."duplicates_checked_at" IS NULL;