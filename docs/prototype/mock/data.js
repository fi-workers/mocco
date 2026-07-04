/* Mocco prototype — static mock data. NOT real. */
window.MOCK = {
  repo: { owner: "acme", name: "deploy-service", installation: "GitHub App #4821" },

  // Workspace = Mocco team boundary (members·roles·integrations·billing). Groups multiple GitHub orgs/repos.
  // Separate from GitHub — only identity is linked, permissions are owned by Mocco (ADR 0002).
  workspace: { name: "acme-labs", slug: "acme-labs", plan: "Team" },
  workspaces: [
    { name: "acme-labs", slug: "acme-labs" },
    { name: "andrea personal", slug: "andrea-personal" },
  ],

  // GitHub orgs linked to the workspace (App install unit)
  orgs: [
    { login: "acme", appId: "#4821", installed: true, repos: 2 },
    { login: "oss-tools", appId: "#5190", installed: true, repos: 2 },
  ],

  // Linked repo list (topbar switcher + Repos management). Switching keeps the same screen data (click-through).
  repos: [
    { owner:"acme", name:"deploy-service", org:"acme", status:"active", moccoYml:true, pipelines:1, gates:1, installation:"#4821", lastDeploy:{ sha:"a1b2c3d", at:"2 hours ago", state:"Succeeded" } },
    { owner:"acme", name:"web-app", org:"acme", status:"active", moccoYml:true, pipelines:2, gates:2, installation:"#4821", lastDeploy:{ sha:"4f2a1b9", at:"yesterday", state:"Succeeded" } },
    { owner:"oss-tools", name:"timeboard", org:"oss-tools", status:"setup", moccoYml:false, pipelines:0, gates:0, installation:"#5190", lastDeploy:null },
    { owner:"oss-tools", name:"checklist", org:"oss-tools", status:"paused", moccoYml:true, pipelines:1, gates:1, installation:"#5190", lastDeploy:{ sha:"c9d0e1f", at:"3 days ago", state:"Failed" } },
  ],

  // Workspace members (WS role — separate from repo governance roles). WS Admin manages repo links, members, and integrations.
  workspaceMembers: [
    { name:"andrea", initials:"AN", email:"andrea@example.com", gh:"@andrea-dev", wsRole:"Owner" },
    { name:"Minseo", initials:"MS", email:"minseo@example.com", gh:"@minseo-dev", wsRole:"Admin" },
    { name:"Sua", initials:"SU", email:"sua@example.com", gh:"@sua-dev", wsRole:"Member" },
    { name:"Taeyun", initials:"TY", email:"taeyun@example.com", gh:"@taeyun-dev", wsRole:"Member" },
    { name:"Haneul", initials:"HN", email:"haneul@example.com", gh:"@haneul-dev", wsRole:"Member" },
    { name:"Jihun", initials:"JH", email:"jihun@example.com", gh:"@jihun-codes", wsRole:"Member" },
  ],
  wsRoles: [
    { role:"Owner", can:"All permissions · billing · delete workspace", count:1 },
    { role:"Admin", can:"repo links · member management · policies · Integrations", count:1 },
    { role:"Member", can:"Assigned repo governance roles only (assigned in Access)", count:4 },
    { role:"Billing", can:"View billing/invoices only", count:0 },
  ],

  // External integrations (Integrations) — owned by the workspace
  integrations: {
    github: [
      { org:"acme", appId:"#4821", status:"active", repos:2, scopes:"actions:write · contents:read · checks:read" },
      { org:"oss-tools", appId:"#5190", status:"active", repos:2, scopes:"actions:write · contents:read · checks:read" },
    ],
    cloud: [
      { provider:"AWS STS (OIDC)", trust:"token.actions.githubusercontent.com", roles:["deploy-prod","deploy-stg"], status:"active" },
      { provider:"GCP Workload Identity", trust:"—", roles:[], status:"not configured" },
    ],
    slack: { workspace:"acme", channel:"#deploys", events:["approval.requested","deployment.succeeded","emergency.override"], status:"active" },
  },

  // Core separation-of-duties numbers (write ≠ deploy)
  access: { write: 12, deploy_prod: 3, approvers: 5 },

  // Mocco standalone permission model — separate from GitHub permissions. Only identity is linked to GitHub.
  syncMode: "Standalone", // or "GitHub team sync"
  members: [
    { name:"andrea", initials:"AN", gh:"@andrea-dev", ghPerm:"admin", linked:true, source:"Mocco (owner)",
      roles:[{env:"production",role:"deployer"},{env:"staging",role:"deployer"}] },
    { name:"Minseo", initials:"MS", gh:"@minseo-dev", ghPerm:"write", linked:true, source:"synced ← @sre",
      roles:[{env:"production",role:"approver · deployer"}] },
    { name:"Sua", initials:"SU", gh:"@sua-dev", ghPerm:"write", linked:true, source:"synced ← @sre",
      roles:[{env:"production",role:"approver · deployer"}] },
    { name:"Taeyun", initials:"TY", gh:"@taeyun-dev", ghPerm:"write", linked:true, source:"synced ← @sre",
      roles:[{env:"production",role:"approver"}] },
    { name:"Haneul", initials:"HN", gh:"@haneul-dev", ghPerm:"write", linked:true, source:"synced ← @security",
      roles:[{env:"production",role:"approver (security)"}] },
    { name:"Jihun", initials:"JH", gh:"@jihun-codes", ghPerm:"write", linked:true, source:"Mocco",
      roles:[{env:"production",role:"deployer"}] },
    { name:"Doyun", initials:"DY", gh:"@doyun-dev", ghPerm:"admin", linked:true, source:"Mocco",
      roles:[], note:"GitHub admin but zero Mocco deploy/approval rights — living proof that write ≠ deploy" },
    { name:"build-bot", initials:"🤖", gh:"@build-bot", ghPerm:"write", linked:true, source:"Mocco",
      roles:[], note:"denied_approvers — bots cannot resume" },
  ],

  // Role = unit of resume permission (people belong to roles, gates reference roles)
  roles: [
    { name:"sre", members:["Minseo","Sua","Taeyun","Jihun","andrea"], note:"resume infra/deploy gates", source:"synced ← @sre" },
    { name:"security", members:["Haneul"], note:"resume security gates", source:"synced ← @security" },
    { name:"release", members:["andrea"], note:"release management", source:"Mocco" },
  ],

  // Pipeline definition (step + gate). No env — gates define governance
  pipelineDef: {
    name:"deploy",
    items:[
      {kind:"step", name:"build", note:"build image · run tests"},
      {kind:"step", name:"deploy-staging", note:"deploy to staging"},
      {kind:"gate", name:"approve", resume:[{role:"sre",count:2},{role:"security",count:1}], prevent_self:true, reason_required:true, credential:"deploy-prod role (OIDC, 15m) — issued by this gate"},
      {kind:"step", name:"deploy-prod", note:"deploy to production (credentials obtained only after gate resume)"},
    ],
  },

  // Pipeline DAG — parallel fan-out/fan-in. Stage = column, parallel stages run several nodes at once.
  // Fan-in: all parallel nodes must succeed to advance to the next stage. Any failure blocks the join.
  pipelineDag: {
    name:"deploy",
    stages:[
      { key:"build",   nodes:[{name:"build", kind:"step", note:"build image"}] },
      { key:"checks",  parallel:true, note:"all must pass to join",
        nodes:[
          {name:"lint",     kind:"step", note:"eslint·prettier"},
          {name:"unit",     kind:"step", note:"jest unit"},
          {name:"e2e",      kind:"step", note:"playwright"},
        ] },
      { key:"staging", nodes:[{name:"deploy-staging", kind:"step", note:"deploy to staging"}] },
      { key:"smoke",   nodes:[{name:"smoke-test", kind:"step", note:"health · key flows"}] },
      { key:"gate",    nodes:[{name:"approve", kind:"gate",
          resume:[{role:"sre",count:2},{role:"security",count:1}],
          credential:"deploy-prod role (OIDC, 15m)"}] },
      { key:"prod",    nodes:[{name:"deploy-prod", kind:"step", note:"credentials only after resume"}] },
    ],
  },

  environments: [
    { key: "production", tier: "production", currentSha: "a1b2c3d", protected: true },
    { key: "staging", tier: "staging", currentSha: "f7e8d90", protected: false },
    { key: "preview", tier: "development", currentSha: "—", protected: false },
  ],

  commits: [
    { sha: "9f3c2a1", message: "fix(billing): correct proration rounding error", author: "Jihun", initials: "JH", at: "8 min ago", workflows: ["deploy.yml"], env: "production", approval: "pending", run: "PendingApproval", runId: "run_318" },
    { sha: "7b1e4d8", message: "feat(api): add workspace invite token TTL", author: "andrea", initials: "AN", at: "41 min ago", workflows: ["deploy.yml"], env: "staging", approval: "noapproval", run: "Succeeded", runId: "run_317" },
    { sha: "a1b2c3d", message: "chore(deps): upgrade supabase-js to 2.51", author: "Minseo", initials: "MS", at: "2 hours ago", workflows: ["deploy.yml"], env: "production", approval: "approved", run: "Succeeded", runId: "run_316" },
    { sha: "c4d5e6f", message: "feat(auth): introduce Lucia session rotation", author: "Jihun", initials: "JH", at: "5 hours ago", workflows: ["deploy.yml"], env: "production", approval: "rejected", run: "Rejected", runId: "run_315" },
    { sha: "0a9b8c7", message: "refactor(ui): virtual scroll for commit queue", author: "andrea", initials: "AN", at: "yesterday", workflows: ["preview.yml"], env: "preview", approval: "noapproval", run: "Succeeded", runId: "run_314" },
    { sha: "d3e2f10", message: "hotfix(infra): raise health check timeout", author: "Minseo", initials: "MS", at: "yesterday", workflows: ["hotfix.yml"], env: "production", approval: "bypass", run: "Blocked", runId: "run_313" },
    { sha: "b7c8d9e", message: "feat(payments): add settlement batch", author: "Sua", initials: "SU", at: "3 hours ago", workflows: ["deploy.yml"], env: "production", approval: "approved", run: "Failed", runId: "run_312" },
    { sha: "e1f2a3b", message: "chore: clean up log format", author: "Jihun", initials: "JH", at: "4 hours ago", workflows: ["deploy.yml"], env: "staging", approval: "noapproval", run: "Failed", runId: "run_311" },
  ],

  // Runs in various states — click through to see different scenarios
  runs: {
    // 1) Pending approval — self-approval block demo
    run_318: {
      id: "run_318", sha: "9f3c2a1", workflow: "deploy.yml", environment: "production",
      message: "fix(billing): correct proration rounding error",
      author: "Jihun", committer: "Jihun", triggeredBy: "Jihun", at: "8 min ago",
      state: "PendingApproval",
      pipe: [ {l:"build",kind:"step",s:"done"}, {l:"deploy-staging",kind:"step",s:"done"}, {l:"approve",kind:"gate",s:"paused"}, {l:"deploy-prod",kind:"step",s:"future"} ],
      dag: { build:"done", lint:"done", unit:"done", e2e:"done", "deploy-staging":"done", "smoke-test":"done", approve:"paused", "deploy-prod":"future" },
      track: [
        {l:"Discovered",s:"done"},{l:"Queued",s:"done"},{l:"PendingApproval",s:"blocked"},
        {l:"Approved",s:"future"},{l:"ReadyToRun",s:"future"},{l:"Dispatched",s:"future"},
        {l:"Running",s:"future"},{l:"Succeeded",s:"future"},
      ],
      approvalRules: [
        { name: "SRE", required: 2, approvers: ["Minseo","Sua","Taeyun"], approved: ["Minseo"] },
        { name: "Security", required: 1, approvers: ["Haneul"], approved: [] },
      ],
      selfApprovalBlockedFor: ["Jihun"], blockReason: "Jihun is the author·committer·triggerer of this commit — self-approval blocked",
      token: { id: "tok_9f3c…e21", bind: ["sha:9f3c2a1","step:deploy-prod","workflow_hash:b8a1…"], ttl: "30m", singleUse: true, status: "reserved (not issued)" },
      dispatch: { allowedTo: "sre, andrea", currentUser: "Jihun", currentUserCanDeploy: true, note: "Jihun is on the sre team → can dispatch. But approval is blocked as self-approval (separate concept)." },
      verify: { status: "pending", detail: "claim submitted at the workflow's first step after dispatch" },
      safety: { outdated: "ok", outdatedNote: "descendant of the current deploy SHA (a1b2c3d)", mode: "oldest_first" },
      credential: { gated: true, note: "no valid token → OIDC STS not issued — real enforcement happens here" },
    },
    // 2) Success — all stages green, 17/17
    run_316: {
      id: "run_316", sha: "a1b2c3d", workflow: "deploy.yml", environment: "production",
      message: "chore(deps): upgrade supabase-js to 2.51",
      author: "Minseo", committer: "Minseo", triggeredBy: "andrea", at: "2 hours ago",
      state: "Succeeded",
      pipe: [ {l:"build",kind:"step",s:"done"}, {l:"deploy-staging",kind:"step",s:"done"}, {l:"approve",kind:"gate",s:"done"}, {l:"deploy-prod",kind:"step",s:"done"} ],
      dag: { build:"done", lint:"done", unit:"done", e2e:"done", "deploy-staging":"done", "smoke-test":"done", approve:"done", "deploy-prod":"done" },
      track: [
        {l:"Discovered",s:"done"},{l:"Queued",s:"done"},{l:"PendingApproval",s:"done"},
        {l:"Approved",s:"done"},{l:"ReadyToRun",s:"done"},{l:"Dispatched",s:"done"},
        {l:"Running",s:"done"},{l:"Succeeded",s:"done"},
      ],
      approvalRules: [
        { name: "SRE", required: 2, approvers: ["Minseo","Sua","Taeyun"], approved: ["Sua","Taeyun"] },
        { name: "Security", required: 1, approvers: ["Haneul"], approved: ["Haneul"] },
      ],
      selfApprovalBlockedFor: ["andrea"], blockReason: "Triggerer andrea cannot approve (blocked). Approvals done by Sua·Taeyun·Haneul.",
      token: { id: "tok_a1b2…7c4", bind: ["sha:a1b2c3d","step:deploy-prod","workflow_hash:b8a1…"], ttl: "30m", singleUse: true, status: "used 08:02 (single-use consumed)" },
      dispatch: { allowedTo: "sre, andrea", currentUser: "andrea", currentUserCanDeploy: true, note: "andrea dispatched. Dispatched at 08:02:10." },
      verify: { status: "passed 17/17", detail: "verification passed at 08:05 → proceeding to deploy", ok: true },
      safety: { outdated: "ok", outdatedNote: "re-verified at dispatch time", mode: "oldest_first" },
      credential: { gated: true, note: "valid token confirmed → OIDC STS issued (role: deploy-prod, 15m)" },
    },
    // 3) Rejected — dispatch permanently blocked
    run_315: {
      id: "run_315", sha: "c4d5e6f", workflow: "deploy.yml", environment: "production",
      message: "feat(auth): introduce Lucia session rotation",
      author: "Jihun", committer: "Jihun", triggeredBy: "Jihun", at: "5 hours ago",
      state: "Rejected",
      dag: { build:"done", lint:"done", unit:"done", e2e:"done", "deploy-staging":"done", "smoke-test":"done", approve:"rejected", "deploy-prod":"future" },
      track: [
        {l:"Discovered",s:"done"},{l:"Queued",s:"done"},{l:"PendingApproval",s:"done"},
        {l:"Rejected",s:"rejected"},
      ],
      approvalRules: [
        { name: "SRE", required: 2, approvers: ["Minseo","Sua","Taeyun"], approved: ["Minseo"] },
        { name: "Security", required: 1, approvers: ["Haneul"], approved: [], rejectedBy: "Haneul", reason: "session rotation rollback path unverified" },
      ],
      selfApprovalBlockedFor: ["Jihun"], blockReason: "author·committer·triggerer Jihun cannot approve",
      token: null,
      dispatch: { allowedTo: "sre, andrea", currentUser: "Jihun", currentUserCanDeploy: true, note: "Rejected — no token issued, dispatch permanently blocked." },
      verify: { status: "not applicable", detail: "dispatch never happened" },
      safety: { outdated: "—", outdatedNote: "", mode: "oldest_first" },
      credential: { gated: true, note: "no token → STS not issued" },
      rejected: { by: "Haneul", at: "06:40", reason: "session rotation rollback path unverified" },
    },
    // 4) hotfix.yml run directly — missing Verify + blocked by credential gating (bypass attempt)
    run_313: {
      id: "run_313", sha: "d3e2f10", workflow: "hotfix.yml", environment: "production",
      message: "hotfix(infra): raise health check timeout",
      author: "Minseo", committer: "Minseo", triggeredBy: "Minseo (run directly in GitHub UI)", at: "yesterday",
      state: "Blocked",
      bypassAttempt: true,
      track: [
        {l:"Run directly in GitHub",s:"done"},{l:"Running",s:"done"},
        {l:"Credential request",s:"done"},{l:"CredentialDenied",s:"blocked"},{l:"Blocked",s:"rejected"},
      ],
      approvalRules: [],
      selfApprovalBlockedFor: [],
      token: null,
      dispatch: { allowedTo: "sre, andrea", currentUser: "Minseo", currentUserCanDeploy: true, note: "Ran hotfix.yml directly from the GitHub UI without going through Mocco — bypass attempt." },
      verify: { status: "no Verify in workflow", detail: "hotfix.yml has no mocco/verify step (unsafe)", fail: true },
      safety: { outdated: "—", outdatedNote: "", mode: "oldest_first" },
      credential: { gated: true, denied: true, note: "no valid Mocco token → OIDC STS issuance denied → deploy.sh cannot obtain prod credentials → deploy fails" },
    },
    // 5) staging success — no approval needed
    run_317: {
      id: "run_317", sha: "7b1e4d8", workflow: "deploy.yml", environment: "staging",
      message: "feat(api): add workspace invite token TTL",
      author: "andrea", committer: "andrea", triggeredBy: "andrea", at: "41 min ago",
      state: "Succeeded",
      track: [
        {l:"Discovered",s:"done"},{l:"Queued",s:"done"},{l:"ReadyToRun",s:"done"},
        {l:"Dispatched",s:"done"},{l:"Running",s:"done"},{l:"Succeeded",s:"done"},
      ],
      approvalRules: [], noApprovalNote: "staging policy: required_approvals 0 — no approval, anyone can deploy",
      selfApprovalBlockedFor: [],
      token: { id: "tok_7b1e…a90", bind: ["sha:7b1e4d8","step:deploy-stg"], ttl: "30m", singleUse: true, status: "used" },
      dispatch: { allowedTo: "developers", currentUser: "andrea", currentUserCanDeploy: true, note: "staging can be deployed by all developers." },
      verify: { status: "passed", detail: "staging runs verify the same way", ok: true },
      safety: { outdated: "ok", outdatedNote: "", mode: "newest_first" },
      credential: { gated: true, note: "staging role STS issued" },
    },
    // 6) preview success — no approval needed
    run_314: {
      id: "run_314", sha: "0a9b8c7", workflow: "preview.yml", environment: "preview",
      message: "refactor(ui): virtual scroll for commit queue",
      author: "andrea", committer: "andrea", triggeredBy: "auto", at: "yesterday",
      state: "Succeeded",
      track: [{l:"Discovered",s:"done"},{l:"ReadyToRun",s:"done"},{l:"Dispatched",s:"done"},{l:"Running",s:"done"},{l:"Succeeded",s:"done"}],
      approvalRules: [], noApprovalNote: "preview policy: auto deploy (trigger auto), no approval needed",
      selfApprovalBlockedFor: [],
      token: { id: "tok_0a9b…11f", bind: ["sha:0a9b8c7","step:preview"], ttl: "30m", singleUse: true, status: "used" },
      dispatch: { allowedTo: "auto", currentUser: "auto", currentUserCanDeploy: true, note: "preview deploys automatically on every commit." },
      verify: { status: "passed", detail: "", ok: true },
      safety: { outdated: "skip", outdatedNote: "preview skips outdated", mode: "newest_first" },
      credential: { gated: false, note: "preview does not use prod credentials" },
    },
    // 7) Failure — config snapshot mismatch at Verify (policy changed after approval)
    run_312: {
      id: "run_312", sha: "b7c8d9e", workflow: "deploy.yml", environment: "production",
      message: "feat(payments): add settlement batch",
      author: "Sua", committer: "Sua", triggeredBy: "andrea", at: "3 hours ago",
      state: "Failed",
      pipe: [ {l:"build",kind:"step",s:"done"}, {l:"deploy-staging",kind:"step",s:"done"}, {l:"approve",kind:"gate",s:"done"}, {l:"deploy-prod",kind:"step",s:"failed"} ],
      track: [
        {l:"Discovered",s:"done"},{l:"Queued",s:"done"},{l:"PendingApproval",s:"done"},
        {l:"Approved",s:"done"},{l:"Dispatched",s:"done"},{l:"VerifyFailed",s:"rejected"},{l:"Failed",s:"rejected"},
      ],
      approvalRules: [
        { name: "SRE", required: 2, approvers: ["Minseo","Sua","Taeyun"], approved: ["Minseo","Taeyun"] },
        { name: "Security", required: 1, approvers: ["Haneul"], approved: ["Haneul"] },
      ],
      selfApprovalBlockedFor: ["andrea"], blockReason: "triggerer andrea cannot approve",
      token: { id: "tok_b7c8…d31", bind: ["sha:b7c8d9e","step:deploy-prod","workflow_hash:c0d2…"], ttl: "30m", singleUse: true, status: "issued → rejected at Verify" },
      dispatch: { allowedTo: "sre, andrea", currentUser: "andrea", currentUserCanDeploy: true, note: "dispatched, but Verify blocked it." },
      verify: { status: "failed — config snapshot mismatch", detail: "config at approval time ≠ at execution time (.mocco.yml changed in between)", fail: true },
      safety: { outdated: "ok", outdatedNote: "", mode: "oldest_first" },
      credential: { gated: true, denied: true, note: "Verify failed → OIDC STS not issued → deploy aborted" },
      failure: { stage: "Verify", reason: "config_snapshot_hash mismatch — policy changed after approval. Re-approval required." },
    },
    // 8) Failure — deploy.sh exited abnormally (retryable)
    run_311: {
      id: "run_311", sha: "e1f2a3b", workflow: "deploy.yml", environment: "staging",
      message: "chore: clean up log format",
      author: "Jihun", committer: "Jihun", triggeredBy: "Jihun", at: "4 hours ago",
      state: "Failed",
      track: [
        {l:"Discovered",s:"done"},{l:"ReadyToRun",s:"done"},{l:"Dispatched",s:"done"},
        {l:"Running",s:"done"},{l:"Failed",s:"rejected"},
      ],
      approvalRules: [], noApprovalNote: "staging policy: no approval needed",
      selfApprovalBlockedFor: [],
      token: { id: "tok_e1f2…7a2", bind: ["sha:e1f2a3b","step:deploy-stg"], ttl: "30m", singleUse: true, status: "used" },
      dispatch: { allowedTo: "developers", currentUser: "Jihun", currentUserCanDeploy: true, note: "dispatched normally, then failed during execution." },
      verify: { status: "passed", detail: "Verify passed, the deploy script failed", ok: true },
      safety: { outdated: "ok", outdatedNote: "", mode: "newest_first" },
      credential: { gated: true, note: "STG STS issued" },
      failure: { stage: "deploy.sh", reason: "deploy script exited abnormally (exit 1). possibly transient → Retry." },
    },
  },

  // Concurrency queue (for comparing process modes)
  concurrencyQueue: {
    group: "deploy",
    holding: { runId: "run_316", sha: "a1b2c3d", since: "08:02", state: "run complete → lock released" },
    waiting: [
      { runId: "run_318", sha: "9f3c2a1", seq: 1, queuedAt: "09:14", note: "pending approval" },
      { runId: "run_312", sha: "b7c8d9e", seq: 2, queuedAt: "09:20", note: "approved, waiting for lock" },
      { runId: "run_320", sha: "c9d0e1f", seq: 3, queuedAt: "09:25", note: "pending approval (latest)" },
    ],
    modes: {
      oldest_first: "in queue-entry order (1→2→3). Guarantees release order. Safe but slow.",
      newest_first: "latest SHA first (3→2→1). Older waiting deploys may be skipped → prevents stale deploys. Jobs must be idempotent.",
      newest_ready_first: "latest ready first, but does not skip an in-progress deploy. Faster than newest_first and safe.",
    },
  },

  // OIDC credential broker — the heart of real enforcement
  credentialBroker: {
    provider: "AWS STS (OIDC)", trust: "token.actions.githubusercontent.com",
    condition: "allow sts:AssumeRole only for runs with a valid, verified Mocco-issued approval token",
    roles: [{ role: "deploy-prod", ttl: "15m" }, { role: "deploy-stg", ttl: "15m" }],
    note: "Even if you delete the Verify Action from the workflow, without a valid token you can't get cloud credentials, so you can't deploy. ← the real basis for the wedge.",
  },

  // break-glass / emergency deploy
  breakGlass: {
    allowed: ["andrea", "sre-oncall"], require_reason: true, post_review: "mandatory post-hoc review within 24h",
    note: "Emergency path for late-night incidents or absent approvers. Every use is flagged red via emergency.override + a mandatory post-hoc review.",
  },

  policy: {
    production: {
      tier: "production",
      allowed_to_deploy: "teams: sre · users: andrea",
      approval: "rules: sre 2 AND security 1",
      prevent_self_approval: "true (author·committer·triggerer)",
      denied: "build-bot",
      concurrency: "oldest_first", prevent_outdated: "reject", rollback: "enabled (outdated exempt · approval required)",
      preconditions: ["merged_to: main", "status checks: ci/test, ci/lint", "code owner review required"],
      secrets: "expose: PROD_DB_URL, PROD_API_KEY · only_on_approved: true",
      oidc: "deploy-prod role, STS only for approved runs",
    },
    staging: {
      tier: "staging",
      allowed_to_deploy: "teams: developers",
      approval: "required_approvals: 0 (no approval)",
      prevent_self_approval: "n/a",
      denied: "—",
      concurrency: "newest_first", prevent_outdated: "skip", rollback: "enabled",
      preconditions: ["merged_to: main"],
      secrets: "expose: STG_DB_URL · only_on_approved: false",
      oidc: "deploy-stg role",
    },
    preview: {
      tier: "development",
      allowed_to_deploy: "auto (trigger automatic)",
      approval: "0 (auto deploy)",
      prevent_self_approval: "n/a",
      denied: "—",
      concurrency: "newest_first (per-commit group)", prevent_outdated: "skip", rollback: "—",
      preconditions: ["—"],
      secrets: "prod credentials not used",
      oidc: "not used",
    },
  },

  verifyChecklist: [
    "run exists · executable", "repo match", "workflow match", "target step match",
    "inputs.commit_sha == token-bound SHA (== approved SHA)", "approval count met", "approver authority",
    "deployer authority (allowed_to_deploy)", "self-approval blocked (author·committer·triggerer)", "token not expired",
    "token single-use · unused", "token workflow_hash match", "not a previously succeeded/canceled run",
    "concurrency lock acquired", "re-evaluate outdated at dispatch/verify time", "change window",
    "config at approval time == config at execution time (snapshot hash)",
  ],
  verifyLimit: "The Verify Action (in-job) can be bypassed (delete the step · continue-on-error). The guarantee that real code == approved SHA is reinforced by workflow integrity (CODEOWNERS/signing) + credential gating. Verify alone is not a security boundary but an early-fail UX.",

  workflows: [
    { file: "deploy.yml", verify: true, safe: true, note: "mocco/verify@v1 present as the first step" },
    { file: "preview.yml", verify: true, safe: true, note: "verify present" },
    { file: "hotfix.yml", verify: false, safe: false, note: "⚠️ Verify missing — blocked by credential gating when run directly (run_313)" },
  ],

  // append-only audit — monotonically increasing time, prev_hash chain
  audit: [
    { day:"yesterday", ts:"18:20:—", actor:"andrea", type:"user", action:"policy.changed", env:"production", sha:"—", result:"ok", reason:"required_approvals 1→2" },
    { day:"yesterday", ts:"21:05:33", actor:"Minseo", type:"user", action:"emergency.override", env:"production", sha:"d3e2f10", result:"denied", reason:"ran hotfix.yml directly — no valid token, OIDC denied", emph:true },
    { day:"today", ts:"06:40:00", actor:"Haneul", type:"user", action:"approval.rejected", env:"production", sha:"c4d5e6f", result:"ok", reason:"session rotation rollback path unverified" },
    { day:"today", ts:"08:01:55", actor:"andrea", type:"user", action:"deployment.requested", env:"production", sha:"a1b2c3d", result:"ok", reason:"" },
    { day:"today", ts:"08:02:10", actor:"github-app", type:"github-app", action:"deployment.dispatched", env:"production", sha:"a1b2c3d", result:"ok", reason:"token tok_a1b2 issued" },
    { day:"today", ts:"08:05:55", actor:"github-app", type:"github-app", action:"deployment.verified", env:"production", sha:"a1b2c3d", result:"ok", reason:"17/17 passed" },
    { day:"today", ts:"08:05:56", actor:"system", type:"system", action:"credential.issued", env:"production", sha:"a1b2c3d", result:"ok", reason:"OIDC STS deploy-prod 15m" },
    { day:"today", ts:"08:09:12", actor:"system", type:"system", action:"deployment.succeeded", env:"production", sha:"a1b2c3d", result:"ok", reason:"" },
    { day:"today", ts:"09:14:02", actor:"Jihun", type:"user", action:"deployment.requested", env:"production", sha:"9f3c2a1", result:"ok", reason:"billing hotfix" },
    { day:"today", ts:"09:14:03", actor:"system", type:"system", action:"precondition.checked", env:"production", sha:"9f3c2a1", result:"ok", reason:"merged_to main, checks pass" },
    { day:"today", ts:"09:15:31", actor:"Minseo", type:"user", action:"approval.granted", env:"production", sha:"9f3c2a1", result:"ok", reason:"SRE 1/2" },
    { day:"today", ts:"09:15:48", actor:"Jihun", type:"user", action:"approval.attempted", env:"production", sha:"9f3c2a1", result:"denied", reason:"self-approval blocked (author·committer·triggerer)", emph:true },
  ],

  // Timing (Vercel-style started·duration·updated)
  runTiming: {
    run_318: { started:"—", duration:"—", updated:"8 sec ago", note:"pending approval (not run)" },
    run_317: { started:"today 08:34", duration:"3m 02s", updated:"41 min ago" },
    run_316: { started:"today 08:02", duration:"7m 17s", updated:"2 hours ago" },
    run_315: { started:"—", duration:"—", updated:"5 hours ago", note:"rejected (not run)" },
    run_314: { started:"yesterday 17:40", duration:"1m 12s", updated:"1 day ago" },
    run_313: { started:"yesterday 21:05", duration:"22s", updated:"1 day ago" },
    run_312: { started:"today 06:51", duration:"1m 48s", updated:"3 hours ago" },
    run_311: { started:"today 05:30", duration:"54s", updated:"4 hours ago" },
  },

  // run logs (mock, per step)
  runLogs: {
    run_316: [
      { name:"mocco/verify@v1", status:"ok", dur:"1.2s", lines:[
        {t:"$ mocco-verify --run run_316",k:"cmd"},{t:"checking 17 conditions…"},{t:"token bound to sha a1b2c3d ✓"},{t:"approvals: SRE 2/2, Security 1/1 ✓"},{t:"verified: 17/17 PASS",k:"ok"}]},
      { name:"actions/checkout@v4", status:"ok", dur:"0.9s", lines:[{t:"$ git checkout a1b2c3d",k:"cmd"},{t:"HEAD is now at a1b2c3d"}]},
      { name:"request credentials (OIDC)", status:"ok", dur:"0.4s", lines:[{t:"requesting STS for env=production…"},{t:"AssumeRole deploy-prod granted (15m) ✓",k:"ok"}]},
      { name:"./deploy.sh", status:"ok", dur:"4m 41s", lines:[{t:"$ ./deploy.sh production",k:"cmd"},{t:"pushing image… done"},{t:"rolling update 3/3 ready"},{t:"deploy succeeded ✓",k:"ok"}]},
    ],
    run_312: [
      { name:"mocco/verify@v1", status:"danger", dur:"0.8s", lines:[
        {t:"$ mocco-verify --run run_312",k:"cmd"},{t:"approvals OK (3/3)"},{t:"comparing config_snapshot_hash…"},{t:"approved: c0d2a9…  current: 7f1e88…",k:"err"},{t:"FAIL: config changed after approval — re-approval required",k:"err"},{t:"exit 403",k:"err"}]},
      { name:"request credentials (OIDC)", status:"danger", dur:"—", lines:[{t:"verify failed → STS not issued",k:"err"},{t:"deploy step unreachable",k:"err"}]},
    ],
    run_311: [
      { name:"mocco/verify@v1", status:"ok", dur:"1.0s", lines:[{t:"verified (staging, no approval) ✓",k:"ok"}]},
      { name:"actions/checkout@v4", status:"ok", dur:"0.8s", lines:[{t:"checkout e1f2a3b"}]},
      { name:"./deploy.sh", status:"danger", dur:"39s", lines:[{t:"$ ./deploy.sh staging",k:"cmd"},{t:"applying migrations…"},{t:"ERROR: migration 0042 failed: duplicate key",k:"err"},{t:"deploy.sh exited with code 1",k:"err"}]},
    ],
    run_313: [
      { name:"hotfix.yml (run directly in GitHub UI)", status:"warn", dur:"3s", lines:[{t:"⚠ no mocco/verify step in workflow",k:"err"},{t:"running deploy job directly…"}]},
      { name:"request credentials (OIDC)", status:"danger", dur:"—", lines:[{t:"no valid Mocco token for this run",k:"err"},{t:"STS AssumeRole DENIED (mocco:run_verified=false)",k:"err"},{t:"deploy.sh cannot obtain prod credentials → blocked",k:"err"}]},
    ],
  },
};
