CREATE TABLE "hourly_spends" (
	"bucket" text NOT NULL,
	"key" text NOT NULL,
	"spent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "hourly_spends_key" ON "hourly_spends" USING btree ("bucket","key","spent_at");--> statement-breakpoint
CREATE INDEX "hourly_spends_at" ON "hourly_spends" USING btree ("bucket","spent_at");