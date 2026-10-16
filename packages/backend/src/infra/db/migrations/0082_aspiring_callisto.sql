CREATE TABLE "mocco_feedback_changelog_reads" (
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"board_id" uuid NOT NULL,
	"end_user_id" text NOT NULL,
	"last_seen_at" timestamp NOT NULL,
	CONSTRAINT "mocco_feedback_changelog_reads_pk" PRIMARY KEY("board_id","end_user_id"),
	CONSTRAINT "mocco_feedback_changelog_reads_end_user_check" CHECK (char_length("mocco_feedback_changelog_reads"."end_user_id") BETWEEN 1 AND 255)
);
--> statement-breakpoint
ALTER TABLE "mocco_feedback_changelog_reads" ADD CONSTRAINT "mocco_feedback_changelog_reads_board_fk" FOREIGN KEY ("board_id","workspace_id","project_id") REFERENCES "public"."mocco_feedback_boards"("id","workspace_id","project_id") ON DELETE cascade ON UPDATE no action;