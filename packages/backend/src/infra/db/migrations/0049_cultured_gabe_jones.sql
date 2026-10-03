CREATE TABLE "mocco_jwks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp,
	"alg" text,
	"crv" text
);
--> statement-breakpoint
CREATE TABLE "mocco_oauth_access_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"client_id" text NOT NULL,
	"session_id" uuid,
	"user_id" uuid,
	"reference_id" text,
	"authorization_code_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"refresh_id" uuid,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"revoked" timestamp,
	"confirmation" jsonb,
	"scopes" text[] NOT NULL,
	CONSTRAINT "mocco_oauth_access_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "mocco_oauth_client_assertions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mocco_oauth_client_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mocco_oauth_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text,
	"client_discovery_id" text,
	"disabled" boolean DEFAULT false,
	"skip_consent" boolean,
	"enable_end_session" boolean,
	"subject_type" text,
	"scopes" text[],
	"client_credentials_scopes" text[] DEFAULT '{}'::text[],
	"user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"name" text,
	"uri" text,
	"icon" text,
	"contacts" text[],
	"tos" text,
	"policy" text,
	"software_id" text,
	"software_version" text,
	"software_statement" text,
	"redirect_uris" text[] NOT NULL,
	"post_logout_redirect_uris" text[],
	"backchannel_logout_uri" text,
	"backchannel_logout_session_required" boolean,
	"token_endpoint_auth_method" text,
	"application_type" text,
	"jwks" text,
	"jwks_uri" text,
	"grant_types" text[],
	"response_types" text[],
	"require_pkce" boolean,
	"dpop_bound_access_tokens" boolean DEFAULT false,
	"reference_id" text,
	"metadata" jsonb,
	CONSTRAINT "mocco_oauth_clients_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "mocco_oauth_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"user_id" uuid,
	"reference_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"scopes" text[] NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mocco_oauth_refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"client_id" text NOT NULL,
	"session_id" uuid,
	"user_id" uuid NOT NULL,
	"reference_id" text,
	"authorization_code_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"revoked" timestamp,
	"rotated_at" timestamp,
	"rotation_replay_response" text,
	"rotation_replay_expires_at" timestamp,
	"auth_time" timestamp,
	"confirmation" jsonb,
	"scopes" text[] NOT NULL,
	CONSTRAINT "mocco_oauth_refresh_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "mocco_oauth_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"name" text NOT NULL,
	"access_token_ttl" integer,
	"refresh_token_ttl" integer,
	"signing_algorithm" text,
	"signing_key_id" text,
	"allowed_scopes" text[],
	"custom_claims" jsonb,
	"dpop_bound_access_tokens_required" boolean DEFAULT false,
	"disabled" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"policy_version" integer DEFAULT 1,
	"metadata" jsonb,
	CONSTRAINT "mocco_oauth_resources_identifier_unique" UNIQUE("identifier")
);
--> statement-breakpoint
ALTER TABLE "mocco_oauth_access_tokens" ADD CONSTRAINT "mocco_oauth_access_tokens_client_id_mocco_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."mocco_oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_oauth_access_tokens" ADD CONSTRAINT "mocco_oauth_access_tokens_session_id_mocco_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."mocco_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_oauth_access_tokens" ADD CONSTRAINT "mocco_oauth_access_tokens_user_id_mocco_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."mocco_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_oauth_access_tokens" ADD CONSTRAINT "mocco_oauth_access_tokens_refresh_id_mocco_oauth_refresh_tokens_id_fk" FOREIGN KEY ("refresh_id") REFERENCES "public"."mocco_oauth_refresh_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_oauth_client_resources" ADD CONSTRAINT "mocco_oauth_client_resources_client_id_mocco_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."mocco_oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_oauth_client_resources" ADD CONSTRAINT "mocco_oauth_client_resources_resource_id_mocco_oauth_resources_identifier_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."mocco_oauth_resources"("identifier") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_oauth_clients" ADD CONSTRAINT "mocco_oauth_clients_user_id_mocco_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."mocco_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_oauth_consents" ADD CONSTRAINT "mocco_oauth_consents_client_id_mocco_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."mocco_oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_oauth_consents" ADD CONSTRAINT "mocco_oauth_consents_user_id_mocco_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."mocco_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_oauth_refresh_tokens" ADD CONSTRAINT "mocco_oauth_refresh_tokens_client_id_mocco_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."mocco_oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_oauth_refresh_tokens" ADD CONSTRAINT "mocco_oauth_refresh_tokens_session_id_mocco_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."mocco_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_oauth_refresh_tokens" ADD CONSTRAINT "mocco_oauth_refresh_tokens_user_id_mocco_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."mocco_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mocco_oauth_access_tokens_client_idx" ON "mocco_oauth_access_tokens" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "mocco_oauth_access_tokens_session_idx" ON "mocco_oauth_access_tokens" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "mocco_oauth_access_tokens_user_idx" ON "mocco_oauth_access_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mocco_oauth_access_tokens_code_idx" ON "mocco_oauth_access_tokens" USING btree ("authorization_code_id");--> statement-breakpoint
CREATE INDEX "mocco_oauth_access_tokens_refresh_idx" ON "mocco_oauth_access_tokens" USING btree ("refresh_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_oauth_client_resources_client_resource_uq" ON "mocco_oauth_client_resources" USING btree ("client_id","resource_id");--> statement-breakpoint
CREATE INDEX "mocco_oauth_client_resources_client_idx" ON "mocco_oauth_client_resources" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "mocco_oauth_client_resources_resource_idx" ON "mocco_oauth_client_resources" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "mocco_oauth_clients_user_idx" ON "mocco_oauth_clients" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mocco_oauth_consents_client_idx" ON "mocco_oauth_consents" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "mocco_oauth_consents_user_idx" ON "mocco_oauth_consents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mocco_oauth_refresh_tokens_client_idx" ON "mocco_oauth_refresh_tokens" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "mocco_oauth_refresh_tokens_session_idx" ON "mocco_oauth_refresh_tokens" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "mocco_oauth_refresh_tokens_user_idx" ON "mocco_oauth_refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mocco_oauth_refresh_tokens_code_idx" ON "mocco_oauth_refresh_tokens" USING btree ("authorization_code_id");