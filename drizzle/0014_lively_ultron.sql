CREATE TABLE "mr_url_drift_metric" (
	"id" varchar(128) PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"run_id" varchar(128) NOT NULL,
	"total_candidates" integer NOT NULL,
	"adopted" integer,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mr_url_drift_metric_run_id_key" UNIQUE("run_id")
);
--> statement-breakpoint
CREATE TABLE "mr_url_drift_review" (
	"id" varchar(128) PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"source_id" varchar(128) NOT NULL,
	"run_id" varchar(128) NOT NULL,
	"old_url" text NOT NULL,
	"candidate_url" text NOT NULL,
	"confidence" text NOT NULL,
	"reason" text NOT NULL,
	"token" varchar(128) NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"flag_opened_at" text NOT NULL,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mr_url_drift_review_token_key" UNIQUE("token")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mr_url_drift_review_source_id_pending_key" ON "mr_url_drift_review" USING btree ("source_id") WHERE status = 'pending';