---
title: End-user identity and hosted auth — competitor research
description: Market scan of customer identity (CIAM) and developer auth vendors — Clerk, Auth0, Supabase, Firebase, WorkOS, Stytch, OSS engines, and Korean login/identity-verification needs — to position Mocco's end-user identity (#100).
type: research
status: active
created: 2026-09-24
updated: 2026-09-24
confidence: medium
owner: andrea
tags: [research, competitors, identity]
related:
  - ../reference/roadmap.md
  - ../specs/2026-09-24-identity-design.md
---

# End-user identity and hosted auth — competitor research

## Summary

Developer auth is a crowded, commoditizing market. Free tiers have converged on 10k to 50k monthly users (Clerk 50k MRU, Supabase and Firebase 50k MAU, Logto 50k MAU, Cognito/Stytch/Hanko/Hexclave 10k). WorkOS gives away the first **1M MAU** and charges for enterprise SSO connections instead. Per-user list prices beyond the free tier run from about $0.003 (Supabase) through $0.015 to $0.02 (Cognito Essentials, Clerk, Kinde, SuperTokens Cloud) up to Auth0, which starts at $35/month for 500 MAU and is the usual "too expensive at scale" story. The market is consolidating. Twilio closed its acquisition of Stytch on 2025-11-14. Stack Auth rebranded to **Hexclave** (AGPL server, MIT SDKs). Better Auth, which Mocco already uses for operator login, now sells a hosted "Infrastructure" tier (dashboard, abuse protection, SSO), so an OSS library company is moving into managed identity. Mocco cannot win on price or breadth against these vendors in a standalone auth product. Its opening is narrower and better defended. (1) Every other Mocco product (messenger, forum, feedback) needs to know who the end user is. That identity layer should accept the customer's existing auth (signed identity, BYO Clerk/Auth0/Supabase JWTs) before it becomes an auth provider itself. (2) Auth configuration changes go through the same gates and hash-chained audit log as deploys. (3) Kakao/Naver login and PASS-style identity verification are built in, which Western vendors treat as custom OAuth or do not offer. (4) AGPL self-hosting runs on the same Next+Postgres stack. Recommendation: ship phase 1 (identity foundation plus BYO auth plus email OTP) as a free, bundled platform capability. Treat phase 2 (hosted auth) as a separately metered MAU product, and gate it on a threat model and an external review.

## Market map

| Segment | Players | Buying motion |
|---|---|---|
| **Developer-first hosted auth (B2C + B2B SaaS)** | Clerk, Kinde, Descope, Stytch (Twilio), Hanko, Hexclave (ex-Stack Auth) | Drop-in UI components, generous free tier, per-MAU pricing |
| **Enterprise CIAM** | Auth0 (Okta), Amazon Cognito, Google Identity Platform, FusionAuth (hosted tiers) | Compliance, SLAs, enterprise federation; priced high per MAU or per plan |
| **BaaS-bundled auth** | Supabase Auth, Firebase Auth | Auth is a free-ish feature of a larger platform. **This is the closest analogue to Mocco's position.** |
| **B2B / enterprise-SSO specialists** | WorkOS AuthKit, (Clerk, Descope, Kinde B2B plans) | Charge per SSO/SCIM connection; user auth nearly free |
| **Open-source engines (self-host first)** | Keycloak (CNCF), Zitadel, Ory (Kratos/Hydra), SuperTokens, Logto, FusionAuth Community, Hexclave, Better Auth (library), Hanko | Free self-host; monetize via cloud, support, or enterprise license |
| **Auth libraries (in-app)** | Better Auth, Auth.js, Lucia-style primitives (arctic, oslo) | No per-user fee; you own the DB and the risk |
| **Korean login and identity verification** | Kakao Login / Kakao Sync, Naver Login, PASS (carriers), aggregators such as PortOne (Danal, KCP, KG Inicis) | Mandatory for Korean consumer apps; social login plus real-name/age verification (CI/DI) |

## Competitor profiles

### Clerk (deep)
- **What:** Hosted auth and user management with prebuilt React components (`<SignIn/>`, `<UserButton/>`, `<OrganizationSwitcher/>`), the default choice for Next.js startups.
- **Target:** B2C and B2B SaaS on React/Next/Expo.
- **Key features:** email/password, magic links, OTP, social, passkeys, MFA, organizations and roles, impersonation, webhooks, JWT templates, JWKS. 2026 launches: Expo **native** components (AuthView, UserButton, UserProfileView, native Google Sign-In, 2026-03-09), API keys GA (2026-04-17), SCIM directory sync (2026-04-16), Clerk CLI (2026-04-22), self-serve SAML SSO (2026-06-26) and OIDC SSO (2026-07-30), Clerk Billing with per-seat plans (2026-06-10), application/email/admin/SMS logs (May to Sept 2026), OAuth device grant (2026-09-08), custom OAuth scopes (2026-08-21).
- **Pricing (2026):** Hobby free, 50,000 **MRU** per app. Pro $25/mo ($20 annual). Business $300/mo ($250 annual). Enterprise custom. Overage $0.02/MRU (50k–100k), $0.018 (100k–1M). "Monthly Retained User" = a user who returns at least one day after signup ("First Day Free"). Extra enterprise connections $75/mo. B2B add-on $100/mo. Administration (unlimited impersonation) add-on $100/mo. Hobby includes 5 impersonations/month.
- **Platforms:** Next.js, React, Remix, Astro, Vue (community), Expo/React Native, iOS (Swift), Android, Node/Go/Python/Ruby backend SDKs.
- **OSS/self-host:** No (SDKs are OSS; service is closed).
- **Strengths:** best-in-class component DX; MRU metric is friendly to high-churn B2C; very fast shipping cadence.
- **Weaknesses:** not self-hostable; vendor lock-in (user table lives at Clerk); add-on pricing stacks up for B2B; outages take down every customer's login.
- Sources: clerk.com/pricing, clerk.com/changelog.

### Auth0 by Okta (deep)
- **What:** The incumbent CIAM platform: Universal Login (hosted), Actions (serverless hooks), Organizations, enterprise federation, attack protection.
- **Target:** mid-market and enterprise B2C/B2B.
- **Pricing (2026):** Free up to 25,000 MAU (B2C and B2B), 5 organizations, 1 enterprise connection on B2B. B2C Essentials from $35/mo (500 MAU), B2C Professional from $240/mo (500 MAU). B2B Essentials from $150/mo (500 MAU, 3 SSO connections, unlimited orgs), B2B Professional from $800/mo (500 MAU, 5 connections). Enterprise custom. Annual = 11x monthly.
- **Platforms:** every major web/mobile/backend SDK; OIDC/SAML/WS-Fed.
- **OSS/self-host:** No (Okta also sells a "private cloud" deployment at enterprise pricing — unverified for 2026).
- **Strengths:** breadth, compliance (SOC2/ISO/HIPAA), Actions extensibility, mature attack protection (breached password, bot detection, brute force).
- **Weaknesses:** steep per-MAU price growth ("growth penalty" is the most common complaint), dated DX vs Clerk, B2B features locked to higher tiers.
- **Recent news:** Okta positions Auth0 around "Auth for GenAI" / AI agents (token vault, async authorization) — unverified details for 2026.
- Sources: auth0.com/pricing.

### Supabase Auth (deep — closest structural analogue)
- **What:** Auth (GoTrue fork) bundled with the Supabase Postgres platform; users live in the project's own `auth.users` table; JWTs are consumed by Postgres RLS.
- **Target:** developers building on Supabase.
- **Pricing (2026):** Free 50,000 MAU; Pro $25/mo includes 100,000 MAU then **$0.00325/MAU**; Team $599/mo; Enterprise custom. **Third-party auth** (Clerk, Firebase Auth, Auth0, Cognito, WorkOS) billed at $0.00325 per third-party MAU beyond quota.
- **Key features:** email/password, magic link, OTP, phone, ~20 social providers, anonymous sign-in, MFA (TOTP/phone), SAML SSO (Pro+), asymmetric JWT signing keys with JWKS, auth hooks. Accepts **third-party JWTs** verified by JWKS with required `kid`.
- **OSS/self-host:** Yes (Apache-2.0 / MIT components).
- **Strengths:** auth is effectively free inside the platform; DB-native user table; BYO-auth path.
- **Weaknesses:** no first-party drop-in component suite comparable to Clerk (Auth UI is thin); B2B orgs absent; tied to Supabase.
- **Lesson for Mocco:** "auth as a platform feature, priced near cost, plus BYO-auth at the same meter" is the model to copy.
- Sources: supabase.com/pricing, supabase.com/docs/guides/auth/third-party/overview.

### WorkOS AuthKit (deep)
- **What:** Hosted auth (AuthKit) plus enterprise-readiness APIs (SSO, SCIM, audit logs, admin portal, Radar fraud detection).
- **Pricing (2026):** AuthKit **free up to 1M MAU**, then $2,500/mo per additional million. SSO and Directory Sync each $125/connection/mo (1–15), tiering down to $65 (51–100). Custom domain $99/mo. Audit log streaming $125/SIEM/mo. Radar free for 1,000 checks then $100 per 50k.
- **Strengths:** sells "enterprise ready" to B2B SaaS; user auth as a loss leader; admin portal for customer IT admins.
- **Weaknesses:** B2C-light; costs concentrate on connections; not self-hostable.
- Sources: workos.com/pricing.

### Stytch (Twilio) (deep)
- **What:** API-first auth (passwordless, passkeys, B2B orgs, device fingerprinting/fraud) now inside Twilio.
- **News:** Twilio signed on 2025-10-30 and closed 2025-11-14. Positioned as the "intelligent identity layer" for humans and AI agents, augmenting Twilio Verify and Lookup. Price not disclosed.
- **Pricing (2026):** Pay-as-you-go from $0; 10,000 MAU (and AI agents) free; volume discounts beyond (per-MAU rate not published on page); fraud fingerprinting 10,000 free then $0.005/fingerprint; SMS/WhatsApp passthrough.
- **Strengths:** strongest fraud/device intelligence among dev-first vendors; Twilio channel reach (SMS, WhatsApp).
- **Weaknesses:** integration roadmap uncertainty post-acquisition; less opinionated UI.
- Sources: stytch.com/pricing, twilio.com/en-us/blog/company/news/twilio-to-acquire-stytch, changelog.stytch.com/announcements/2025-11-14-a-new-chapter-begins-stytch-joins-twilio.

### Firebase Auth / Google Identity Platform
- **Pricing:** Firebase Auth free up to 50k MAU on Spark and Blaze. SAML/OIDC free only to 50 MAU. Above that, Identity Platform rates apply: Tier 1 (email, social, phone, anonymous) about $0.0055/MAU in the 50k–100k band, Tier 2 (SAML/OIDC) $0.015/MAU. SMS is billed per message by region.
- **Strengths:** mobile SDK maturity, anonymous auth, cheap.
- **Weaknesses:** Google-cloud lock-in; limited B2B; weak user-admin UI; SMS pumping costs.
- Sources: firebase.google.com/pricing, cloud.google.com/identity-platform/pricing, blog.logto.io/firebase-authentication-pricing.

### Amazon Cognito
- **Pricing (2026):** Lite tier $0.0055/MAU (first 90k, above 10k free) then $0.0046. Essentials, the default tier, $0.015/MAU above 10k free. Plus $0.02/MAU with no free tier (threat protection, compromised credential detection). SAML/OIDC federation $0.015/MAU above 50 free. M2M $0.00225 per token request.
- **Strengths:** AWS-native, cheap Lite tier. **Weaknesses:** notoriously poor DX, limited hosted UI customization, pool attributes immutable.
- Source: aws.amazon.com/cognito/pricing.

### Descope
- **What:** No-code "flows" builder for auth journeys, B2B tenants, SSO.
- **Pricing:** Free 7,500 MAU, 10 tenants, 3 SSO connections. Pro from $249/mo (10k MAU, 35 tenants, 5 SSO). Growth from $799/mo (25k MAU, 100 tenants, 10 SSO). Enterprise custom.
- **Strengths:** visual flows; **Weaknesses:** expensive jump from free to paid.
- Source: descope.com/pricing.

### Kinde
- **What:** Auth plus feature flags plus billing for SaaS founders (Australia).
- **Pricing:** Free 10,500 MAU. Pro $25/mo (+$0.0175/MAU over 10,500). Plus $75/mo (+$0.0163). Scale $250/mo (+$0.0151). Billing platform fee 0.5–0.7%. Paying subscribers do not count toward MAU.
- **Relevance:** the closest "all-in-one for developers" peer (auth + flags + billing), which is Mocco's multi-product thesis in miniature.
- Source: kinde.com/pricing.

### Hexclave (formerly Stack Auth) — OSS
- **What:** Open-source "user infrastructure": auth, teams/RBAC, payments, emails, webhooks, analytics, session replay. YC company. Rebranded from Stack Auth; env vars renamed `STACK_*` to `HEXCLAVE_*`.
- **Pricing:** Free (10,000 auth users, 1 admin), Team $49/mo (50,000 users), Growth $299/mo (unlimited).
- **License:** server **AGPL-3.0**, client SDKs MIT; commercial license available. This is the same license posture as Mocco.
- Sources: hexclave.com/pricing, github.com/hexclave/stack-auth.

### Better Auth — OSS library plus hosted Infrastructure
- **What:** TypeScript auth library (Mocco pins `better-auth@1.6.23` for operators). Latest release line is 1.7.x (v1.7.5 per GitHub releases). Plugins cover organizations, passkeys, TOTP/OTP 2FA, email OTP, SSO/SAML, SCIM (1.7), Expo client, JWT with JWKS (EdDSA default; ES256/RS256/PS256; rotation interval plus grace period; private keys AES-256-GCM encrypted), and an **OAuth 2.1 Provider** plugin (authorize/token/userinfo/introspect/revoke/JWKS, OIDC discovery, PKCE mandatory for public clients, dynamic client registration). Also OAuth device grant, back-channel logout, DPoP.
- **Hosted "Better Auth Infrastructure":** Starter free (1 seat, 10k audit logs), Pro $20/mo (unlimited seats, email/SMS, self-serve SSO with 1 connection then $50/mo each), custom domain $25/mo, log drain $25/mo, Enterprise custom. It is an add-on to your self-run library, not a hosted user pool. The self-serve SSO dashboard in 1.5 (2026-02-28) runs on it.
- **Multi-tenant user pools:** Better Auth's organization plugin models memberships, not isolated user pools. Emails are unique per instance. Per-project isolated pools therefore need either an instance per pool or a custom adapter (see design). **Unverified:** a first-class multi-pool mode.
- Sources: better-auth.com/pricing, better-auth.com/docs/plugins/jwt, better-auth.com/docs/plugins/oauth-provider, better-auth.com/blog/1-5, github.com/better-auth/better-auth/releases.

### Keycloak (CNCF)
- **What:** Java IAM server; realms equal isolated pools; OIDC/SAML; Organizations (26.x).
- **2026:** 26.5 (Jan 2026) adds Workflows, JWT Authorization Grant, and Kubernetes service-account client auth. 26.6 (Apr 2026) takes zero-downtime patch updates, federated client auth, and Workflows to GA, plus DPoP guides and experimental Client ID Metadata Documents. Passkeys are fully supported since 26.4.
- **Pricing:** free (Apache-2.0); Red Hat build for support.
- **Strength:** realm-per-tenant is a proven pattern for per-project pools. **Weakness:** heavy JVM ops, dated UX theming.
- Sources: keycloak.org/2026/04/keycloak-2660-released, cncf.io/blog/2025/11/07/self-hosted-human-and-machine-identities-in-keycloak-26-4.

### Zitadel
- **What:** Go, event-sourced IAM with infrastructure-level multi-tenancy (instances, then orgs) and immutable event audit trail.
- **Pricing:** Free 100 **DAU**; Pro $100/mo with 25,000 DAU; Enterprise custom (cloud or self-host).
- **License:** AGPL-3.0 (some dirs Apache/MIT).
- **Relevance:** "every mutation is an immutable event" is conceptually close to Mocco's audit chain.
- Sources: zitadel.com/pricing, github.com/zitadel/zitadel.

### Ory (Kratos, Hydra, Keto, Oathkeeper)
- **Pricing (Ory Network):** Developer free (no production). Production $770/yr with $0.14 per aDAU. Growth $9,350/yr with $0.12 per aDAU and 3 orgs. Enterprise custom. OSS components are Apache-2.0; some features sit under the Ory Enterprise License (unverified detail).
- **Strength:** composable, headless, standards-strict (OpenID certified Hydra). **Weakness:** no drop-in UI, steep learning curve.
- Source: ory.com/pricing.

### SuperTokens
- **Pricing:** self-host free, no MAU limit. Cloud $0.02/MAU after 5,000 free. Paid add-ons: MFA $0.01/MAU (min $100/mo), account linking $0.005/MAU (min $100/mo), dashboard users $20/user/mo after 3, multi-tenancy custom.
- **Strength:** self-host friendly with prebuilt UI. **Weakness:** paid add-ons on self-host for key features.
- Source: supertokens.com/pricing.

### Logto
- **Pricing:** Free 50,000 MAU. Pro from $24/mo with **unlimited MAU**, billed by **tokens** (50k included, then $0.08 per 100). Add-ons for RBAC, orgs, MFA, SSO. Enterprise custom. OSS self-host (MPL-2.0 — unverified).
- **Relevance:** token-based metering is an alternative to MAU worth noting.
- Source: logto.io/pricing.

### FusionAuth
- **Pricing:** Community free (self-host, unlimited users). Starter from $162/mo (annual, basic hosting). Essentials and Enterprise from $2,970/mo (annual). Pricing scales with MAU. Not OSS (free-to-use binary).
- Source: fusionauth.io/pricing.

### Hanko
- **Pricing:** Starter free (10,000 MAU, 2 projects). Pro $29/mo + $0.01/MAU over 10k (webhooks, admin API, SAML SSO $49/connection/mo). Enterprise custom. MAU = user receiving or validating a session token in the month. Does not block signups over quota. Hosted only in AWS Frankfurt. Passkey-first; OSS core.
- Source: hanko.io/pricing.

### Korean market: social login and identity verification
- **Kakao Login:** OAuth 2.0 with optional **OpenID Connect** (ID token issued when OIDC is enabled in console). Refresh tokens rotate on renewal. Some consent items (for example email, phone) require switching to a **business app** and passing business information review (exact item list unverified). Services must call unlink on account deletion and destroy data. Incomplete signups are auto-unlinked after 24h. Overseas transfer of personal data needs explicit disclosure and consent (relevant for a US-hosted Mocco). Kakao Sync bundles signup consent (unverified detail). Sources: developers.kakao.com/docs/en/kakaologin/common, developers.kakao.com/docs/en/kakaologin/prerequisite.
- **Naver Login:** OAuth 2.0 with profile API (name, email, mobile, birthday subject to review). OIDC support unverified (the developer site was not fetchable).
- **Apple App Store guideline 4.8:** an iOS app whose primary account uses a third-party social login (Kakao, Naver, Google) must also offer an equivalent privacy-preserving login option (in practice Sign in with Apple). Exempt: government/industry-backed citizen ID. **Implication:** if Mocco offers Kakao/Naver in RN components, Sign in with Apple must ship in the same slice. Source: developer.apple.com/app-store/review/guidelines.
- **PASS / mobile identity verification:** Korean services commonly require real-name, adult, or unique-person verification. Aggregators like **PortOne** expose Danal, KCP, and KG Inicis (the last unifying PASS, Toss, Naver, Kakao, financial certificates, Samsung Pass). The client SDK opens the flow, then the server fetches the result by `identityVerificationId`. Results include **CI** (cross-service person key), **DI** (per-service dedupe key), name, gender, birthdate, phone, carrier, and foreigner flag. Priced per contract (unverified). Source: developers.portone.io/opi/ko/extra/identity-verification/readme-v2.
- **Korean CIAM vendors:** no Korean developer-first equivalent of Clerk was found (unverified). Korean teams typically combine Firebase/Supabase/Auth0 with custom Kakao/Naver OAuth and a PortOne verification integration. This is a real gap.

## Feature matrix

Legend: Y = yes, P = partial/paid add-on/plugin, N = no, ? = unverified.

| Capability | Clerk | Auth0 | Supabase | Firebase/GIP | WorkOS | Stytch | Descope | Kinde | Hexclave | Better Auth | Keycloak | Zitadel | Ory | SuperTokens | Logto | FusionAuth | Hanko | Cognito |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Hosted sign-in UI | Y | Y | P | P | Y | P | Y | Y | Y | N (lib) | Y | Y | P (headless) | Y | Y | Y | Y | Y |
| React components | Y | P | P | P | Y | Y | Y | Y | Y | P | N | P | P | Y | P | P | Y (web comp.) | P |
| React Native / Expo | Y (native) | Y | Y | Y | P | Y | Y | Y | ? | Y (Expo) | N | P | P | Y | Y | P | P | Y |
| Email OTP / magic link | Y | Y | Y | Y (link) | Y | Y | Y | Y | Y | Y | P | Y | Y | Y | Y | Y | Y | Y |
| Passkeys | Y | Y | ? | P | Y | Y | Y | Y | Y | Y | Y | Y | Y | ? | Y | Y | Y | Y |
| TOTP MFA | Y | Y | Y | P | Y | Y | Y | Y | Y | Y | Y | Y | Y | P | Y | Y | Y | Y |
| Orgs / B2B roles | Y (P) | Y (P) | N | N | Y | Y | Y | Y | Y | Y | Y | Y | P | P | Y (P) | Y | N | N |
| Enterprise SSO (SAML/OIDC) | P | P | P | P | P ($/conn) | Y | Y | P | ? | P | Y | Y | Y | P | P | P | P | Y |
| JWKS / offline verification | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y |
| BYO external JWT as identity | N | P (token exchange) | Y | N | N | N | ? | N | ? | P | Y (brokering) | Y | P | N | ? | P | N | P (identity pools) |
| Signed identity for widgets (HMAC) | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N |
| Per-project isolated pools | Y (instance) | Y (tenant) | Y (project) | Y (project/tenant) | Y (env) | Y (project) | Y | Y | Y | N (per instance) | Y (realm) | Y (instance) | Y (project) | P | Y | Y (tenant) | Y | Y (pool) |
| Impersonation | P | P | N | N | Y | ? | Y | ? | ? | Y (admin plugin) | Y | Y | N | ? | ? | ? | N | N |
| Webhooks on user events | Y | P (Actions/log streams) | P (hooks) | P (functions) | Y | Y | Y | Y | Y | P (hooks) | P (events SPI) | Y | Y | P | Y | Y | P | P (triggers) |
| Bot / breached-password protection | Y | Y | P (captcha) | P | Y (Radar) | Y (strong) | Y | ? | P | P (Infra) | P | P | P | P | P | Y (paid) | ? | P (Plus) |
| Kakao / Naver login | P (custom OIDC) | P (custom social) | P (Kakao built-in) | P (custom OIDC) | N | N | ? | ? | ? | Y (Kakao/Naver providers — unverified Naver) | P | P | P | P | Y (connectors) | P | N | P (custom OIDC) |
| Korean identity verification (PASS/CI) | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N |
| Open source / self-host | N | N | Y | N | N | N | N | N | Y (AGPL) | Y (MIT lib) | Y | Y (AGPL) | Y | Y | Y | P (free binary) | Y (core) | N |
| Auth config changes governed + audit chain | N | P (logs) | N | N | P (audit logs) | ? | ? | N | N | P (Infra audit) | P (admin events) | Y (event store) | N | N | P | P | N | P (CloudTrail) |

## Pricing comparison (list prices, 2026)

| Vendor | Free tier | Entry paid plan | Marginal per-user price | Unit | Notes |
|---|---|---|---|---|---|
| Clerk | 50,000 MRU/app | $25/mo Pro | $0.02 (to 100k), $0.018 (to 1M) | Monthly **retained** user | Add-ons: B2B $100, admin $100, SSO $75/conn |
| Auth0 | 25,000 MAU | $35/mo (500 MAU) B2C; $150/mo B2B | steep tiered (not published per-MAU) | MAU | Enterprise MFA, SSO in higher tiers |
| Supabase | 50,000 MAU | $25/mo Pro (100k MAU) | $0.00325 | MAU (third-party MAU same) | Auth bundled with DB platform |
| Firebase / Identity Platform | 50,000 MAU | Blaze pay-as-you-go | ~$0.0055 (Tier 1, 50k–100k); $0.015 SAML/OIDC | MAU | SMS extra |
| Cognito | 10,000 MAU (Lite/Essentials) | pay-as-you-go | $0.0055 Lite; $0.015 Essentials; $0.02 Plus | MAU | Federation $0.015 above 50 |
| WorkOS AuthKit | 1,000,000 MAU | pay-as-you-go | $2,500 per extra 1M | MAU | SSO/SCIM $125→$65 per connection |
| Stytch | 10,000 MAU | pay-as-you-go | not published | MAU | Fingerprinting $0.005 each |
| Descope | 7,500 MAU | $249/mo (10k MAU) | overage (not published) | MAU | $799 Growth |
| Kinde | 10,500 MAU | $25/mo | $0.0175 → $0.0151 | MAU | Paying subscribers excluded |
| Hexclave | 10,000 users | $49/mo (50k) | flat tiers | Users | AGPL self-host free |
| Better Auth | library free | Infra $20/mo | none (you host users) | Seats/usage | SSO $50/conn |
| Hanko | 10,000 MAU | $29/mo | $0.01 | MAU (session validation) | Frankfurt only |
| SuperTokens | self-host unlimited; cloud 5k | pay-as-you-go | $0.02 cloud; MFA +$0.01 | MAU | |
| Logto | 50,000 MAU | $24/mo | $0.08 per 100 tokens | Tokens | Unlimited MAU on Pro |
| Zitadel | 100 DAU | $100/mo (25k DAU) | not published | DAU | AGPL |
| Ory Network | dev only | $770/yr | $0.14 → $0.12 | aDAU | |
| FusionAuth | Community self-host unlimited | $162/mo (annual) | tiered by MAU | MAU | |
| Keycloak | free | n/a (Red Hat support) | none | — | Apache-2.0 |

## Gaps and opportunities for Mocco

1. **Nobody sells "identity for your support/community stack that accepts your existing auth."** Intercom-style HMAC `user_hash` and Discourse-style SSO are one-off features inside each tool. A single project-level end-user directory that messenger, forum, and feedback share, fed by the customer's existing Clerk/Auth0/Supabase JWT or an HMAC signature, has no direct competitor. Supabase's third-party auth is the closest, and it only feeds its DB.
2. **Governed auth configuration.** No vendor puts "disable MFA requirement", "add redirect URI", "rotate signing key", or "impersonate user" behind an approval gate with a tamper-evident audit chain. Zitadel's event store and WorkOS audit logs record actions but do not gate them. Mocco already has gates and the hash chain.
3. **Korea.** Kakao/Naver login plus Sign in with Apple (App Store 4.8) plus PASS-style CI/DI verification, packaged as first-class methods. Western vendors need custom OAuth config and none offer identity verification. Korean teams build this by hand.
4. **Self-host with the same stack.** Hexclave and Zitadel are AGPL too, but they run as separate services. Mocco identity runs inside the platform customers already self-host (Node 22 + Postgres, no JVM, no Redis requirement).
5. **Price.** The market floor is Supabase at $0.00325/MAU and WorkOS free to 1M. If identity is bundled free for Mocco products and priced near Supabase for general auth, Mocco removes the "Clerk growth penalty" objection without starting a price war.
6. **Cross-product context.** One end user carries their messenger conversations, forum posts, feedback votes, and (via deploy data) which release they are on. No auth vendor has that.

## Recommended positioning and v1 feature set

**Positioning:** "One end-user identity for every Mocco product. Bring your own auth today; let Mocco be your auth tomorrow. Governed, audited, self-hostable, Korea-ready."

### Table stakes (must have to be credible)
- Per-project isolated user pools; users, identities, and sessions visible in an admin screen (search, view, ban, delete/GDPR export).
- Asymmetric JWT access tokens (ES256 default, RS256 option) with a per-project **JWKS** endpoint, key rotation, and refresh-token rotation with reuse detection.
- Email OTP (code-first; link optional), rate limits, enumeration-safe responses.
- Web SDK (`@mocco/identity-js`, React provider and hooks) plus server verification helper (Node).
- Phase 2: hosted sign-in pages, React and RN components, email+password with breached-password check, Google/Apple/GitHub social, passkeys, TOTP MFA, webhooks (`user.created`, `user.updated`, `user.deleted`, `session.created`, `session.revoked`).

### Differentiators
- **Signed identity (HMAC and JWT) and BYO-issuer JWT** (Clerk, Auth0, Supabase, Firebase, Cognito, WorkOS, any OIDC JWKS) as first-class identity sources in phase 1.
- **Governed changes:** security-relevant identity config changes and operator actions (impersonate, bulk delete, key rotation) flow through Mocco gates and land in the hash-chained audit log.
- **Korean methods:** Kakao and Naver login with Sign in with Apple bundled; PASS-style identity verification (via a neutral `IdentityVerifier` port, PortOne first) storing DI and verified attributes.
- **Bundled pricing:** end users of Mocco products are free. General hosted auth is metered per MAU near cost ($0.003–$0.005), with a 50k MAU free tier to match Supabase and Firebase.
- AGPL self-host in the same deployment; no separate auth server.

### Deliberately skip (v1 and likely v2)
- SAML/SCIM enterprise SSO (WorkOS owns it; revisit only on demand).
- SMS OTP (SMS pumping fraud and cost; revisit with a provider and a fraud budget).
- A visual flow builder (Descope-style) or serverless Actions.
- Becoming a general OAuth authorization server for third-party apps (dynamic client registration, consent screens). Phase 2 issues tokens for the customer's own first-party apps only.
- Machine-to-machine and AI-agent identity (API keys belong to a separate Mocco concern).
- Device fingerprinting/fraud scoring beyond captcha plus rate limits.

## Sources

- https://clerk.com/pricing
- https://clerk.com/changelog
- https://auth0.com/pricing
- https://supabase.com/pricing
- https://supabase.com/docs/guides/auth/third-party/overview
- https://workos.com/pricing
- https://stytch.com/pricing
- https://www.twilio.com/en-us/blog/company/news/twilio-to-acquire-stytch
- https://changelog.stytch.com/announcements/2025-11-14-a-new-chapter-begins-stytch-joins-twilio
- https://changelog.stytch.com/announcements/2025-10-30-stytch-is-joining-twilio-same-product-bigger-mission
- https://firebase.google.com/pricing
- https://cloud.google.com/identity-platform/pricing
- https://blog.logto.io/firebase-authentication-pricing
- https://aws.amazon.com/cognito/pricing/
- https://www.descope.com/pricing
- https://kinde.com/pricing/
- https://www.hexclave.com/pricing
- https://github.com/hexclave/stack-auth
- https://www.ycombinator.com/companies/hexclave
- https://www.better-auth.com/pricing
- https://better-auth.com/blog/1-5
- https://better-auth.com/docs/infrastructure/introduction
- https://www.better-auth.com/docs/plugins/jwt
- https://www.better-auth.com/docs/plugins/oauth-provider
- https://github.com/better-auth/better-auth/releases
- https://www.keycloak.org/2026/04/keycloak-2660-released
- https://www.keycloak.org/2026/01/keycloak-2650-released
- https://www.cncf.io/blog/2025/11/07/self-hosted-human-and-machine-identities-in-keycloak-26-4/
- https://zitadel.com/pricing
- https://github.com/zitadel/zitadel
- https://www.ory.com/pricing
- https://supertokens.com/pricing
- https://logto.io/pricing
- https://fusionauth.io/pricing
- https://www.hanko.io/pricing
- https://developers.kakao.com/docs/en/kakaologin/common
- https://developers.kakao.com/docs/en/kakaologin/prerequisite
- https://developer.apple.com/app-store/review/guidelines/
- https://developers.portone.io/opi/ko/extra/identity-verification/readme-v2
