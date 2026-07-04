CREATE TABLE "mr_price_review" (
	"id" varchar(128) PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"plan_id" varchar(128) NOT NULL,
	"old_value" numeric(12, 2),
	"candidate_value" numeric(12, 2),
	"currency" varchar(3),
	"source_url" text NOT NULL,
	"source_confidence" text NOT NULL,
	"token" varchar(128) NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mr_price_review_token_key" UNIQUE("token")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mr_price_review_plan_id_pending_key" ON "mr_price_review" USING btree ("plan_id") WHERE status = 'pending';