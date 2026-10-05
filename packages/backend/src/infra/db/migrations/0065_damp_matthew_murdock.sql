CREATE TABLE "mocco_help_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"article_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"helpful" boolean NOT NULL,
	"comment" text,
	"visitor_hash" text NOT NULL,
	"day" date NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_help_feedback_comment_check" CHECK (char_length("mocco_help_feedback"."comment") <= 500)
);
--> statement-breakpoint
ALTER TABLE "mocco_help_feedback" ADD CONSTRAINT "mocco_help_feedback_article_fk" FOREIGN KEY ("article_id","workspace_id") REFERENCES "public"."mocco_help_articles"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_help_feedback_visitor_day_uq" ON "mocco_help_feedback" USING btree ("article_id","visitor_hash","day");--> statement-breakpoint
CREATE INDEX "mocco_help_feedback_project_article_day_idx" ON "mocco_help_feedback" USING btree ("project_id","article_id","day");