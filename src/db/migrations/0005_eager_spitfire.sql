ALTER TABLE "diagnostic_usage" DROP CONSTRAINT "diagnostic_usage_user_id_day_pk";--> statement-breakpoint
ALTER TABLE "diagnostic_usage" ADD COLUMN "kind" text DEFAULT 'diagnosis' NOT NULL;--> statement-breakpoint
ALTER TABLE "diagnostic_usage" ADD CONSTRAINT "diagnostic_usage_user_id_day_kind_pk" PRIMARY KEY("user_id","day","kind");
