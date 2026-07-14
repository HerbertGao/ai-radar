ALTER TABLE "ai_news_events" ADD COLUMN "published_at_authority" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "ai_news_events" SET "published_at_authority" = 2 WHERE "published_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_news_events" ADD CONSTRAINT "ai_news_events_published_at_authority_check" CHECK (("ai_news_events"."published_at" IS NULL) = ("ai_news_events"."published_at_authority" = 0));
