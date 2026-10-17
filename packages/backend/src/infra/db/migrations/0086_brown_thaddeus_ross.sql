CREATE TABLE "mocco_feedback_post_embeddings" (
	"post_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"model" text NOT NULL,
	"dims" integer NOT NULL,
	"embedding" real[] NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_feedback_post_embeddings_dims_check" CHECK ("mocco_feedback_post_embeddings"."dims" > 0 AND cardinality("mocco_feedback_post_embeddings"."embedding") = "mocco_feedback_post_embeddings"."dims")
);
--> statement-breakpoint
ALTER TABLE "mocco_feedback_duplicate_candidates" DROP CONSTRAINT "mocco_feedback_duplicate_candidates_method_check";--> statement-breakpoint
ALTER TABLE "mocco_feedback_post_embeddings" ADD CONSTRAINT "mocco_feedback_post_embeddings_post_fk" FOREIGN KEY ("post_id","workspace_id") REFERENCES "public"."mocco_feedback_posts"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_feedback_duplicate_candidates" ADD CONSTRAINT "mocco_feedback_duplicate_candidates_method_check" CHECK ("mocco_feedback_duplicate_candidates"."method" IN ('fulltext','embedding'));