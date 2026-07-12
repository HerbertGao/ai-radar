CREATE TABLE "rag_conversations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" varchar(128) DEFAULT 'local' NOT NULL,
	"conversation_id" varchar(128) NOT NULL,
	"turn" integer NOT NULL,
	"raw_query" text,
	"rewritten_query" text,
	"hit_kb_ids" jsonb,
	"answer" text,
	"evidence" varchar(16),
	"model" varchar(128),
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "rag_conversations_user_id_conversation_id_turn_key" UNIQUE("user_id","conversation_id","turn")
);
--> statement-breakpoint
CREATE INDEX "rag_conversations_user_id_conversation_id_idx" ON "rag_conversations" USING btree ("user_id","conversation_id");