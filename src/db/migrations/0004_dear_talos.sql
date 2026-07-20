CREATE TABLE "vehicle_diagnosis_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"symptom" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vehicle_diagnosis_log" ADD CONSTRAINT "vehicle_diagnosis_log_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_diagnosis_log" ADD CONSTRAINT "vehicle_diagnosis_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vehicle_dx_log_vehicle_idx" ON "vehicle_diagnosis_log" USING btree ("vehicle_id");