CREATE TABLE "organization_sprites_configuration" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"memory_mb" integer DEFAULT 8192 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" text,
	CONSTRAINT "organization_sprites_configuration_memory_mb_check" CHECK ("organization_sprites_configuration"."memory_mb" > 0)
);
--> statement-breakpoint
ALTER TABLE "organization_sprites_configuration" ADD CONSTRAINT "organization_sprites_configuration_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_sprites_configuration" ADD CONSTRAINT "organization_sprites_configuration_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;