/* Mocco prototype — vanilla hash router + renderers. No real logic. */
const M = window.MOCK;
const $ = (s, r = document) => r.querySelector(s);

// Consistent inline SVG icons (Lucide-style). Fixes the per-glyph size/baseline inconsistency — fixed 16px box.
const ICONS = {
  queue: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>',
  access: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>',
  pipeline: '<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  audit: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  repos: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  members: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  integrations: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
  workspace: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
  repo: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
};
function svg(key){ return `<svg class="ic-svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[key]||''}</svg>`; }

// Pipelines & Gates sub-tabs (Concurrency and Verify are folded in here)
function policyTabs(active){
  const tabs=[["#/policy","Pipeline & Gates"],["#/concurrency","Concurrency"],["#/verify","Verify & enforcement"]];
  return `<div class="tabs">${tabs.map(([r,l])=>`<a class="tab ${active===r?'active':''}" href="${r}">${l}</a>`).join("")}</div>`;
}

const NAV = [
  { group: "Governance" },
  { route: "#/queue", ico: "queue", label: "Deploy Queue" },
  { route: "#/access", ico: "access", label: "Access" },
  { route: "#/policy", ico: "pipeline", label: "Pipelines & Gates" },
  { route: "#/audit", ico: "audit", label: "Audit Log" },
  { route: "#/settings", ico: "settings", label: "Settings" },
  { group: "Workspace" },
  { route: "#/repos", ico: "repos", label: "Repos" },
  { route: "#/members", ico: "members", label: "Members" },
  { route: "#/integrations", ico: "integrations", label: "Integrations" },
];

function badge(text) {
  const map = { Succeeded:"ok", Running:"info", PendingApproval:"warn", Approved:"ok", Rejected:"danger",
    Blocked:"danger", Failed:"danger", VerifyFailed:"danger", Discovered:"neutral", Dispatched:"info",
    approved:"ok", pending:"warn", rejected:"danger", bypass:"danger", noapproval:"neutral" };
  const labels = { pending:"Pending approval", approved:"Approved", rejected:"Rejected", bypass:"Bypass blocked", noapproval:"No approval" };
  return `<span class="badge ${map[text]||"neutral"}"><span class="dot"></span>${labels[text]||text}</span>`;
}
const avatar = (i)=>`<span class="avatar">${i}</span>`;

// GitLab-style status icon + label
function statusIcon(state){
  const m = {
    Succeeded:["ok","✓","passed"], Running:["info","●","running"], PendingApproval:["warn","▶","manual"],
    Approved:["ok","✓","approved"], Rejected:["danger","✕","rejected"], Blocked:["danger","✕","blocked"],
    Failed:["danger","✕","failed"], VerifyFailed:["danger","✕","verify failed"], Dispatched:["info","▸","dispatched"],
    Discovered:["neutral","·","discovered"],
  };
  const [cls,sym,label] = m[state] || ["neutral","·",state];
  return `<span class="status-cell ${cls}"><span class="sicon ${cls}">${sym}</span>${state}</span>`;
}

let toastT;
function toast(msg){
  let t = $("#toast"); if(!t){ t=document.createElement("div"); t.id="toast"; document.body.appendChild(t);
    Object.assign(t.style,{position:"fixed",bottom:"24px",left:"50%",transform:"translateX(-50%)",
      background:"#2b211c",color:"#fff",padding:"10px 18px",borderRadius:"8px",fontSize:"13px",
      zIndex:99,boxShadow:"0 6px 24px rgba(0,0,0,.2)",opacity:0,transition:"opacity .2s"}); }
  t.textContent = "🧪 Prototype — " + msg; t.style.opacity=1;
  clearTimeout(toastT); toastT=setTimeout(()=>t.style.opacity=0,1900);
}
window.proto = (msg)=>toast(msg);

/* ---------- Deploy Queue ---------- */
// List-row progress — mini stepper based on run.track + current step label + n/total
function queueProgress(runId){
  const r = M.runs[runId];
  if(!r || !r.track || !r.track.length) return '';
  const track = r.track;
  const active = track.find(s=>s.s==='blocked'||s.s==='rejected'||s.s==='current')
    || [...track].reverse().find(s=>s.s==='done') || track[track.length-1];
  const cls = active.s==='rejected'?'danger':active.s==='blocked'?'warn':active.s==='current'?'info':'ok';
  const doneN = track.filter(s=>s.s==='done').length;
  const segs = track.map(s=>`<span class="seg ${s.s}"></span>`).join('');
  return `<div class="qprog"><div class="qsegs">${segs}</div><span class="qprog-lbl ${cls}">${active.l}</span><span class="qprog-n">${doneN}/${track.length}</span></div>`;
}
function scQueue(){
  return `
  <h1 class="page-title">Deploy Queue</h1>
  <p class="page-sub">main commits = deploy candidates. GitHub Actions runs it; Mocco approves & triggers.</p>
  <div class="card" style="padding:0">
    <table class="tbl"><thead><tr>
      <th>Commit</th><th>Author</th><th>Gate</th><th>Run</th><th>Duration · updated</th><th></th>
    </tr></thead><tbody>
    ${M.commits.map(c=>{
      const t = M.runTiming[c.runId] || {};
      const canRetry = ["Failed","Blocked"].includes(c.run);
      const canStop = ["PendingApproval","Running","Dispatched"].includes(c.run);
      return `
      <tr class="clickable" onclick="location.hash='#/run/${c.runId}'">
        <td><div style="font-weight:600">${c.message}</div><div class="muted" style="font-size:12px"><span class="sha">${c.sha}</span> · ${c.workflows.map(w=>w==="hotfix.yml"?'<span style="color:var(--danger)">'+w+'</span>':w).join(", ")}</div>${queueProgress(c.runId)}</td>
        <td><span class="author">${avatar(c.initials)} ${c.author}</span></td>
        <td>${badge(c.approval)}</td>
        <td>${statusIcon(c.run)}</td>
        <td><span class="dur-pill">${t.duration&&t.duration!=='—'?t.duration:'—'}</span> <span class="age">· ${t.updated||c.at}</span></td>
        <td onclick="event.stopPropagation()"><span class="rowact">
          ${canRetry?`<button class="btn sm" onclick="proto('Retry')">↻</button>`:''}
          ${canStop?`<button class="btn sm" onclick="proto('Cancel (stop)')">■</button>`:''}
          <a class="btn sm" href="#/run/${c.runId}">Detail →</a>
        </span></td>
      </tr>`;}).join("")}
    </tbody></table>
  </div>`;
}

/* ---------- Run Detail ---------- */
function stepper(track){
  return `<div class="stepper">${track.map(s=>{
    const cls = {done:"done",blocked:"blocked",rejected:"rejected",future:"future",current:"current"}[s.s]||"";
    const mark = s.s==="done"?"✓":s.s==="blocked"?"▶":s.s==="rejected"?"✕":s.s==="current"?"●":"";
    return `<div class="step ${cls}"><span class="bar"></span><span class="node">${mark||"·"}</span><span class="lbl">${s.l}</span></div>`;
  }).join("")}</div>`;
}
function esc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
// pipeline stepper: step(○) + gate(▣ pause/resume)
function pipeStepper(pipe){
  return `<div class="stepper">${pipe.map(s=>{
    const isGate = s.kind==="gate";
    const cls = {done:"done",paused:"blocked",rejected:"rejected",failed:"rejected",future:"future",current:"current"}[s.s]||"";
    const mark = s.s==="done"?"✓":s.s==="paused"?"▶":(s.s==="rejected"||s.s==="failed")?"✕":s.s==="current"?"●":(isGate?"▶":"·");
    return `<div class="step ${cls} ${isGate?'gate':''}"><span class="bar"></span><span class="node">${mark}</span><span class="lbl">${isGate?'▶ '+s.l:s.l}</span></div>`;
  }).join("")}</div>`;
}
// DAG (parallel fan-out/fan-in). stages = columns; parallel stages stack nodes vertically.
// state: {nodeName: done|running|paused|rejected|failed|future}. Absent = definition (template) view.
function dagNode(n, state){
  const s = state[n.name] || "future";
  const cls = {done:"done",running:"current",current:"current",paused:"blocked",blocked:"blocked",rejected:"rejected",failed:"rejected"}[s] || "future";
  const isGate = n.kind==="gate";
  const mark = s==="done"?"✓":(s==="paused"||s==="blocked")?"▶":(s==="rejected"||s==="failed")?"✕":(s==="running"||s==="current")?"●":(isGate?"▶":"○");
  const sub = isGate && n.resume
    ? `<div class="dag-sub">${n.resume.map(r=>`${r.role} ×${r.count}`).join(" · ")}</div>`
    : (n.note?`<div class="dag-sub">${n.note}</div>`:"");
  return `<div class="dag-node ${cls} ${isGate?'gate':''}"><span class="dag-mark">${mark}</span>
    <div class="dag-body"><div class="dag-name">${isGate?'▶ ':''}${esc(n.name)}</div>${sub}</div></div>`;
}
function dagView(stages, state){
  const st = state || {};
  const arrow = `<div class="dag-arrow"><span class="ln"></span><span class="hd">▸</span></div>`;
  const cols = stages.map(stg=>{
    const inner = stg.nodes.map(n=>dagNode(n, st)).join("");
    if(stg.parallel) return `<div class="dag-col"><div class="dag-par"><span class="dag-par-tag">parallel · ${esc(stg.note||'')}</span>${inner}</div></div>`;
    return `<div class="dag-col">${inner}</div>`;
  });
  return `<div class="dag">${cols.join(arrow)}</div>`;
}
function logPanel(runId){
  const steps = M.runLogs[runId];
  if(!steps) return `<div class="notice info"><span class="ic">ℹ︎</span><div>Not dispatched yet — no logs.</div></div>`;
  return `<div class="logs">${steps.map(s=>`
    <div class="log-step">
      <div class="hdr"><span class="sdot ${s.status}"></span>${esc(s.name)}<span class="dur">${s.dur||''}</span></div>
      <div class="lines">${s.lines.map((l,i)=>`<div class="ln ${l.k||''}"><span class="n">${i+1}</span><span class="t">${esc(l.t)}</span></div>`).join("")}</div>
    </div>`).join("")}</div>`;
}

function scRun(runId){
  const r = M.runs[runId] || M.runs.run_318;
  const t = M.runTiming[r.id] || { started:"—", duration:"—", updated:"—" };
  const hasApproval = r.approvalRules && r.approvalRules.length>0;
  const allMet = hasApproval && r.approvalRules.every(x=>x.approved.length>=x.required && !x.rejectedBy);
  const totalReq = hasApproval ? r.approvalRules.reduce((a,x)=>a+x.required,0):0;
  const totalApp = hasApproval ? r.approvalRules.reduce((a,x)=>a+x.approved.length,0):0;
  const isPending = r.state==="PendingApproval";
  const term = ["Succeeded","Rejected","Blocked","Failed"].includes(r.state);
  const canDispatch = !term && !r.bypassAttempt && (allMet || !hasApproval);
  const canStop = !term;

  // action bar
  let acts = "";
  if (isPending) acts += `<button class="btn primary" onclick="proto('Pretend gate resume (approve)')">▶ Resume (approve)</button><button class="btn danger" onclick="proto('Reject')">Reject</button>`;
  if (canDispatch) acts += `<button class="btn primary" onclick="proto('Call workflow_dispatch (ref:main, commit_sha + token)')">▶ Dispatch</button>`;
  if (canStop) acts += `<button class="btn" onclick="proto('Cancel run (stop)')">■ Stop</button>`;
  if (r.state==="Failed") acts += `<button class="btn primary" onclick="proto('Retry same SHA')">↻ Retry</button>`;
  if (r.state==="Succeeded") acts += `<button class="btn" onclick="proto('Re-deploy')">↻ Re-deploy</button><button class="btn" onclick="proto('Roll back to last good SHA — outdated waived, separate approval')">⤺ Rollback</button>`;
  if (r.state==="Blocked") acts += `<button class="btn primary" onclick="proto('Re-run through the proper Mocco path')">↻ Re-run via Mocco</button>`;
  acts += `<a class="btn ghost" href="#" onclick="proto('Link out to GitHub Actions run');return false">GitHub ↗</a>`;

  // banner
  let banner = "";
  if (r.bypassAttempt) banner = `<div class="block-banner"><span class="lock">🛑</span><div><b>Bypass attempt blocked.</b> ${r.dispatch.note} ${r.credential.note}</div></div>`;
  else if (r.state==="Rejected") banner = `<div class="block-banner"><span class="lock">⛔</span><div><b>Rejected.</b> ${r.rejected.by} · ${r.rejected.at} — "${r.rejected.reason}". No token issued; dispatch permanently blocked.</div></div>`;
  else if (isPending && r.selfApprovalBlockedFor.length) banner = `<div class="block-banner"><span class="lock">🔒</span><div><b>${r.selfApprovalBlockedFor.join(", ")}</b> — ${r.blockReason}. (self-approval not allowed even with GitHub write access)</div></div>`;
  else if (r.state==="Succeeded") banner = `<div class="block-banner" style="background:var(--ok-bg);border-color:var(--ok-border);color:#0b6638"><span class="lock">✓</span><div><b>Deploy succeeded.</b> approve → token issued → dispatch → Verify 17/17 → OIDC STS → done. (${t.duration})</div></div>`;
  else if (r.state==="Failed" && r.failure) banner = `<div class="block-banner"><span class="lock">✕</span><div><b>Failed — ${r.failure.stage} stage.</b> ${r.failure.reason}</div></div>`;

  // approval card (rules only — actions live in the header action bar)
  let approvalCard;
  if (r.bypassAttempt) {
    approvalCard = `<div class="card"><h3>Approval</h3><div class="card-sub">Direct run bypassing Mocco</div>
      <div class="notice danger"><span class="ic">⛔</span><div><b>Bypassed</b> the approval/token step itself (ran directly in the GitHub UI) → no valid token → blocked by credential gating.</div></div></div>`;
  } else if (!hasApproval) {
    approvalCard = `<div class="card"><h3>Gate</h3><div class="card-sub">${r.noApprovalNote||"No gate on this path — no resume needed"}</div>
      <div class="notice info"><span class="ic">ℹ︎</span><div>${r.noApprovalNote||"No gate (auto-proceed)"}</div></div></div>`;
  } else {
    approvalCard = `<div class="card">
      <div class="card-head"><h3>Gate · resume access (roles)</h3><span class="right badge ${allMet?'ok':(r.state==='Rejected'?'danger':'warn')}">${r.state==='Rejected'?'Rejected':totalApp+'/'+totalReq+' resume'}</span></div>
      <div class="card-sub" style="margin-top:-8px">▶ approve gate — resume required from the roles below</div>
      ${r.approvalRules.map((rule,i)=>`
        ${i>0?'<div class="and-chip">AND</div>':''}
        <div class="rule">
          <div style="flex:1"><b>${rule.name}</b> <span class="badge neutral" style="margin-left:4px">role</span> <span class="muted">· ${rule.approvers.join(", ")}</span>
            ${rule.rejectedBy?`<div class="muted" style="font-size:12px;color:var(--danger)">✕ ${rule.rejectedBy} rejected — ${rule.reason}</div>`:''}</div>
          <span class="meter ${rule.rejectedBy?'pending':(rule.approved.length>=rule.required?'met':'pending')}">${rule.approved.length}/${rule.required}</span>
        </div>`).join("")}
      ${r.selfApprovalBlockedFor.length?`<div class="notice danger section-gap"><span class="ic">⛔</span><div><b>${r.selfApprovalBlockedFor.join(", ")}</b> can't resume — ${r.blockReason} (<code>prevent_self</code>)</div></div>`:''}
    </div>`;
  }

  const du = r.dispatch;
  // summary card — dispatch authorization + token + enforcement in one place (tidies up card sprawl)
  const summaryCard = `<div class="card"><h3>Summary · enforcement</h3><div class="card-sub">Dispatch authorization · token · why bypass fails</div>
    <div class="kv">
      <div class="k">allowed_to_deploy</div><div><b>${du.allowedTo}</b></div>
      <div class="k">Current user</div><div>${du.currentUser} ${du.currentUserCanDeploy?'<span class="badge ok">can deploy ✔</span>':'<span class="badge danger">denied ✘</span>'}</div>
      <div class="k">Credential gating</div><div>${r.credential.denied?'<span class="badge danger">STS denied</span>':r.credential.gated?'<span class="badge ok">OIDC gated</span>':'<span class="badge neutral">unused</span>'}</div>
      <div class="k">Verify Action</div><div>${r.verify.ok?'<span class="badge ok">'+r.verify.status+'</span>':r.verify.fail?'<span class="badge danger">'+r.verify.status+'</span>':'<span class="badge warn">'+r.verify.status+'</span>'}</div>
      <div class="k">Outdated</div><div>${r.safety.outdated==='ok'?'<span class="badge ok">passed</span>':r.safety.outdated==='skip'?'<span class="badge neutral">skip</span>':'<span class="badge neutral">—</span>'} <span class="muted" style="font-size:12px">${r.safety.outdatedNote||''}</span></div>
      <div class="k">Concurrency</div><div><span class="badge accent">${r.safety.mode}</span></div>
    </div>
    ${r.token?`<div class="token-card section-gap">
      <div class="row"><span class="key">token</span><span>${r.token.id}</span></div>
      <div class="row"><span class="key">bind</span><span>${r.token.bind.join(" · ")}</span></div>
      <div class="row"><span class="key">ttl · use</span><span>${r.token.ttl} · single</span></div>
      <div class="row"><span class="key">status</span><span>${r.token.status}</span></div>
    </div>`:`<div class="notice danger section-gap"><span class="ic">∅</span><div>No token issued — ${r.state==='Rejected'?'rejected':'no valid approval'}</div></div>`}
  </div>`;

  const commit = M.commits.find(c=>c.sha===r.sha) || {};
  const commitCard = `<div class="card commit-card">
    <div class="commit-head"><span class="commit-label">Deploying commit</span>
      <a class="right btn ghost sm" href="#" onclick="proto('View commit ${r.sha} on GitHub');return false">View on GitHub ↗</a></div>
    <div class="commit-body">
      ${avatar(commit.initials || r.author.slice(0,2).toUpperCase())}
      <div class="commit-main">
        <div class="commit-msg">${r.message}</div>
        <div class="commit-sub">
          <span class="sha">${r.sha}</span>
          <span class="muted">on <b>main</b></span>
          <span class="muted">· ${r.author} authored${r.triggeredBy && r.triggeredBy!==r.author?` · ${r.triggeredBy} triggered`:''}</span>
          <span class="muted">· ${r.workflow}</span>
          ${commit.at||r.at?`<span class="muted">· ${commit.at||r.at}</span>`:''}
        </div>
      </div>
    </div>
  </div>`;

  return `
  <div class="run-head">
    <div>
      <h1 class="ttl">Run ${r.id} <span class="badge ${({Succeeded:'ok',Failed:'danger',Rejected:'danger',Blocked:'danger',PendingApproval:'warn'})[r.state]||'neutral'}">${r.state}</span></h1>
      <div class="meta"><span class="timing">⧖ started <b>${t.started}</b><span class="dot-sep"></span>${t.duration}<span class="dot-sep"></span>updated ${t.updated}</span>${t.note?`<span class="muted">· ${t.note}</span>`:''}</div>
    </div>
    <div class="actions">${acts}</div>
  </div>
  ${commitCard}
  ${banner}
  <div class="card"><div class="card-head"><h3>Pipeline</h3><span class="right muted" style="font-size:12px">○ step · ▶ gate(pause/resume) · parallel fan-in</span></div>${r.dag?dagView(M.pipelineDag.stages,r.dag):r.pipe?pipeStepper(r.pipe):stepper(r.track)}</div>
  <div class="grid cols-2 section-gap">
    ${approvalCard}
    ${summaryCard}
  </div>
  <div class="card section-gap"><div class="card-head"><h3>Logs</h3><a class="right btn ghost sm" href="#" onclick="proto('Link out to GitHub Actions logs');return false">GitHub Actions ↗</a></div>
    ${logPanel(r.id)}
  </div>`;
}

/* ---------- Access (independent access, role-centric) ---------- */
function scAccess(){
  const permBadge = (p)=> p==="admin"?'<span class="badge danger">admin</span>':'<span class="badge neutral">'+p+'</span>';
  const rolesOf = (name)=> M.roles.filter(r=>r.members.includes(name)).map(r=>r.name);
  const initialsOf = (name)=>{ const m=M.members.find(x=>x.name===name); return m?m.initials:name.slice(0,1); };
  return `
  <h1 class="page-title">Access (permissions)</h1>
  <p class="page-sub"><b>Roles exist → people belong → gates reference roles.</b> Mocco owns access and it's <b>independent of GitHub permissions</b> — GitHub only links identity.</p>

  <div class="block-banner" style="background:var(--primary-soft);border-color:#d9c9f5;color:var(--primary-ink)">
    <span class="lock">⊙</span><div><b>Core principle:</b> Even with GitHub write/admin, no Mocco role means no resume or deploy. Mocco access is <b>never derived</b> from GitHub permissions.</div></div>

  <div class="card"><div class="card-head"><h3>Roles (the unit of resume access)</h3><span class="right muted" style="font-size:12px">Gates reference these roles</span></div>
    <table class="tbl"><thead><tr><th>Role</th><th>Members</th><th>Purpose</th><th>source</th></tr></thead><tbody>
    ${M.roles.map(r=>`<tr>
      <td><b>${r.name}</b> <span class="badge accent" style="margin-left:4px">role</span></td>
      <td>${r.members.map(n=>`<span class="author" style="margin-right:8px">${avatar(initialsOf(n))} ${n}</span>`).join("")}</td>
      <td class="muted">${r.note}</td>
      <td class="muted" style="font-size:12px">${r.source}</td>
    </tr>`).join("")}
    </tbody></table>
  </div>

  <div class="card section-gap"><div class="card-head"><h3>Members ↔ GitHub identity</h3>
    <span class="right badge ${M.syncMode.startsWith('Standalone')?'neutral':'ok'}">Sync: ${M.syncMode}</span></div>
    <table class="tbl"><thead><tr>
      <th>Member</th><th>GitHub identity</th><th>GitHub permission</th><th>Mocco role</th>
    </tr></thead><tbody>
    ${M.members.map(m=>{ const rs=rolesOf(m.name); return `
      <tr>
        <td><span class="author">${avatar(m.initials)} ${m.name}</span></td>
        <td class="mono" style="font-size:12px">${m.gh} ${m.linked?'<span class="badge ok" style="margin-left:4px">linked</span>':''}</td>
        <td>${permBadge(m.ghPerm)}</td>
        <td>${rs.length?rs.map(x=>`<span class="badge accent" style="margin:1px 2px">${x}</span>`).join(""):'<span class="badge danger">No role</span>'}${m.note?`<div class="muted" style="font-size:11.5px;margin-top:4px">${m.note}</div>`:''}</td>
      </tr>`;}).join("")}
    </tbody></table>
  </div>

  <div class="grid cols-2 section-gap">
    <div class="card"><h3>GitHub sync (optional)</h3><div class="card-sub">One-way GitHub → Mocco · opt-in · for identity/convenience</div>
      <div class="kv">
        <div class="k">Current mode</div><div><span class="badge neutral">${M.syncMode}</span></div>
        <div class="k">Identity link</div><div>GitHub login ↔ Mocco member (for resume/audit, verified identities only)</div>
        <div class="k">Role mapping (optional)</div><div>Convenience mapping like <code>@sre team → sre role</code></div>
      </div>
      <div class="row-flex section-gap"><button class="btn" onclick="proto('GitHub team → role sync (one-way, opt-in)')">Enable GitHub team sync</button></div>
    </div>
    <div class="card"><h3>What Mocco never does</h3><div class="card-sub">Independence guardrails</div>
      <ul class="checklist" style="columns:1">
        <li><span class="c" style="color:var(--danger)">✕</span> GitHub write/admin ⇒ auto-grant a Mocco role</li>
        <li><span class="c" style="color:var(--danger)">✕</span> Let a GitHub repo admin bypass gate policy</li>
        <li><span class="c" style="color:var(--danger)">✕</span> Grant roles to unverified identities (deny by default)</li>
      </ul>
      <div class="notice info section-gap"><span class="ic">ℹ︎</span><div>Standalone by default. Sync is an optional layer — Mocco is fully self-contained even with it off.</div></div>
    </div>
  </div>`;
}

/* ---------- Pipelines & Gates ---------- */
function scPolicy(){
  const pd = M.pipelineDef;
  const dag = M.pipelineDag;
  const gate = pd.items.find(x=>x.kind==="gate");
  return `
  <h1 class="page-title">Pipelines & Gates</h1>
  ${policyTabs("#/policy")}
  <p class="page-sub">The repo's <code>.mocco.yml</code> = pipeline + gates. <b>No env</b> — gates define governance (ADR 0003).</p>

  <div class="card"><div class="card-head"><h3>pipeline: ${dag.name}</h3><span class="right muted" style="font-size:12px">○ step · ▶ gate · parallel fan-in</span></div>
    ${dagView(dag.stages)}
    <div class="notice info section-gap"><span class="ic">ℹ︎</span><div><b>parallel fan-in</b>: <code>lint · unit · e2e</code> run concurrently — <b>all must pass</b> to join into deploy-staging. If any one fails, the join is blocked (deploy never reached).</div></div>
  </div>

  <div class="grid cols-2 section-gap">
    <div class="card"><h3>▶ ${gate.name} gate — resume access</h3><div class="card-sub">Role-based. People belong to roles, and gates reference roles</div>
      <div class="kv">
        <div class="k">resume requirement</div><div>${gate.resume.map(r=>`<b>${r.role}</b> ×${r.count}`).join(' <span class="and-chip" style="display:inline">AND</span> ')}</div>
        <div class="k">prevent_self</div><div><span class="badge ok">true</span> author · committer · triggerer</div>
        <div class="k">reason_required</div><div><span class="badge ok">true</span></div>
        <div class="k">Credential</div><div>${gate.credential}</div>
      </div>
      <div class="notice info section-gap"><span class="ic">ℹ︎</span><div>Gates plug in anywhere — before deploy, before migration… "resume required from here." Role membership lives in <a href="#/access">Access</a>.</div></div>
    </div>
    <div class="card"><h3>🔑 Credential gating · concurrency · safety</h3><div class="card-sub">Bound to the gate</div>
      <div class="kv">
        <div class="k">credential broker</div><div>${M.credentialBroker.provider}</div>
        <div class="k">issue condition</div><div>STS only for gate-resumed runs</div>
        <div class="k">concurrency</div><div><span class="badge accent">oldest_first</span> (resource group)</div>
        <div class="k">prevent_outdated</div><div><span class="badge danger">reject</span> (ancestor check)</div>
        <div class="k">rollback</div><div>enabled · outdated waived (separate gate)</div>
      </div></div>
  </div>
  <div class="grid cols-2 section-gap">
    <div class="card"><h3>Dispatch preconditions</h3><div class="card-sub">Verify GitHub facts before the pipeline starts</div>
      <ul class="checklist" style="columns:1"><li><span class="c">✓</span> merged_to: main</li><li><span class="c">✓</span> status checks: ci/test, ci/lint</li><li><span class="c">✓</span> code owner review required</li></ul></div>
    <div class="card"><h3>🚨 Break-glass (emergency) <span class="later-pill">post-MVP</span></h3><div class="card-sub">No resumer available · middle-of-the-night incident</div>
      <div class="kv"><div class="k">allowed</div><div>${M.breakGlass.allowed.join(", ")}</div>
        <div class="k">require_reason</div><div><span class="badge ok">true</span></div>
        <div class="k">post-hoc</div><div>${M.breakGlass.post_review}</div></div>
      <div class="notice warn section-gap"><span class="ic">⚠︎</span><div>Every use is a red-flagged emergency.override audit + post-hoc review.</div></div></div>
  </div>
  <div class="card section-gap"><div class="card-head"><h3>.mocco.yml (raw)</h3><button class="right btn ghost sm" onclick="proto('Edit modal')">Edit</button></div>
    ${yamlPipe()}
  </div>`;
}
function yamlPipe(){
  const L=(s,c="")=>`<span class="${c}">${s}</span>`;
  return `<pre class="code">${L("pipeline:",'k')} deploy
${L("steps:",'k')}
  - ${L("run:",'k')} build
  - ${L("run:",'k')} deploy-staging
  - ${L("gate:",'k')} ${L("approve",'b')}                 ${L("# pause/resume",'c')}
    ${L("resume:",'k')} [ { role: ${L("sre",'s')}, count: 2 }, { role: ${L("security",'s')}, count: 1 } ]   ${L("# AND",'c')}
    ${L("prevent_self:",'k')} true             ${L("# author + committer + triggerer",'c')}
    ${L("reason_required:",'k')} true
    ${L("credential:",'k')} { oidc_role: deploy-prod, ttl: 15m }   ${L("# issued by this gate",'c')}
  - ${L("run:",'k')} deploy-prod          ${L("# credentials only after resume",'c')}
${L("concurrency:",'k')} { group: deploy, mode: ${L("oldest_first",'s')} }
${L("safety:",'k')} { prevent_outdated: ${L("reject",'s')} }
${L("audit:",'k')} { hash_chain: true }</pre>`;
}

/* ---------- Concurrency ---------- */
let concMode = "oldest_first";
function scConcurrency(){
  const q = M.concurrencyQueue;
  const modeKeys = Object.keys(q.modes);
  // order waiting per selected mode
  let ordered = q.waiting.slice();
  if (concMode === "oldest_first") ordered.sort((a,b)=>a.seq-b.seq);
  else ordered.sort((a,b)=>b.seq-a.seq); // newest_first / newest_ready_first: newest first
  const skipOldest = concMode === "newest_first";
  const tabs = modeKeys.map(k=>`<div class="tab ${concMode===k?'active':''}" onclick="concMode='${k}';render()">${k}</div>`).join("");
  return `
  <h1 class="page-title">Pipelines & Gates</h1>
  ${policyTabs("#/concurrency")}
  <p class="page-sub">Resource-group concurrency lock + process mode. Equivalent to GitLab resource_group — beyond a simple lock, a <b>wait-queue ordering policy</b>. <span class="later-pill">post-MVP</span> <span class="muted" style="font-size:12px">MVP defaults to <span class="mono">oldest_first</span>, no UI.</span></p>

  <div class="card"><div class="card-head"><h3>Lock group: ${q.group}</h3><span class="right badge accent">${concMode}</span></div>
    <div class="row-flex" style="margin-bottom:6px"><span class="badge ok"><span class="dot"></span>HOLDING</span>
      <span class="sha">${q.holding.sha}</span><span class="muted">${q.holding.runId} · ${q.holding.since} · ${q.holding.state}</span></div>
  </div>

  <div class="card section-gap"><div class="card-head"><h3>Process mode</h3></div>
    <div class="tabs">${tabs}</div>
    <div class="notice info"><span class="ic">ℹ︎</span><div>${q.modes[concMode]}</div></div>
  </div>

  <div class="card section-gap"><h3>Wait queue (${concMode} order)</h3><div class="card-sub">Changing the mode changes the next dispatch order</div>
    ${ordered.map((w,i)=>{
      const skipped = skipOldest && i>0 && w.seq < ordered[0].seq;
      return `<div class="rule">
        <span class="badge ${i===0?'accent':'neutral'}">${i===0?'Next ▶':'#'+(i+1)}</span>
        <div style="flex:1"><b class="sha">${w.sha}</b> <span class="muted">${w.runId} · queued ${w.queuedAt} (seq ${w.seq})</span>
          <div class="muted" style="font-size:12px">${w.note}</div></div>
        ${skipped?'<span class="badge danger">skippable (stale)</span>':''}
      </div>`;
    }).join("")}
    ${skipOldest?`<div class="notice warn section-gap"><span class="ic">⚠︎</span><div>newest_first: deploy the latest (${ordered[0].sha}) first, and older queued deploys can be <b>skipped</b> as outdated. Safe only if jobs are idempotent.</div></div>`:''}
  </div>`;
}

/* ---------- Verify & Enforcement ---------- */
function scVerify(){
  return `
  <h1 class="page-title">Pipelines & Gates</h1>
  ${policyTabs("#/verify")}
  <p class="page-sub">The real reason bypass fails is <b>credential gating</b> (MVP core). The Verify Action itself is early-fail UX <span class="later-pill">post-MVP</span> on top of it.</p>

  <div class="card"><div class="card-head"><h3>① Enforcement: Cloud credential gating (load-bearing)</h3><span class="right badge ok">Primary mechanism</span></div>
    <div class="grid cols-2">
      <div><div class="kv">
        <div class="k">How</div><div>Mocco is the cloud credential broker. It <b>issues OIDC STS</b> only to runs verified with a valid token.</div>
        <div class="k">Result</div><div>Even if you delete the Verify step from the workflow → no valid token → no STS → deploy.sh can't obtain prod credentials → <b>can't deploy</b>.</div>
        <div class="k">trust</div><div class="mono" style="font-size:11px">${M.credentialBroker.trust}</div>
      </div></div>
      <div><pre class="code"><span class="c"># AWS IAM trust (OIDC) — concept</span>
<span class="k">Condition:</span>
  StringEquals:
    <span class="s">mocco:run_verified</span>: <span class="s">"true"</span>
    <span class="s">mocco:token_valid</span>: <span class="s">"true"</span>
<span class="c"># Only Mocco can set this claim</span>
<span class="c"># → bypass runs are denied AssumeRole</span></pre></div>
    </div>
  </div>

  <div class="grid cols-2 section-gap">
    <div class="card"><div class="card-head"><h3>② Verify Action (early-fail UX)</h3><span class="right badge neutral">Secondary</span></div>
      <div class="card-sub">First step of the deploy job — submits the claim + fails fast. <b>Not a security boundary</b> (the step can be deleted).</div>
      <pre class="code"><span class="k">steps:</span>
  - <span class="k">uses:</span> <span class="s">mocco/verify@v1</span>
    <span class="k">with:</span> { run-id, token, commit-sha }
  - <span class="k">uses:</span> <span class="s">actions/checkout@v4</span>
    <span class="k">with:</span> { ref: \${{ inputs.commit_sha }} }
  - <span class="k">run:</span> ./deploy.sh</pre>
      <div class="notice warn section-gap"><span class="ic">⚠︎</span><div>${M.verifyLimit}</div></div>
    </div>
    <div class="card"><h3>17 verification checks</h3><div class="card-sub">Token binding · approval · permissions · outdated re-check · config snapshot</div>
      <ul class="checklist">${M.verifyChecklist.map(c=>`<li><span class="c">✓</span>${c}</li>`).join("")}</ul>
    </div>
  </div>

  <div class="card section-gap"><div class="card-head"><h3>Workflow safety check</h3><span class="right muted" style="font-size:12px">Verify missing = unsafe (direct runs blocked by credentials)</span></div>
    <table class="tbl"><thead><tr><th>Workflow</th><th>Verify Action</th><th>Status</th><th>Notes</th></tr></thead><tbody>
    ${M.workflows.map(w=>`<tr>
      <td class="sha">${w.file}</td>
      <td>${w.verify?'<span class="badge ok">present</span>':'<span class="badge danger">missing</span>'}</td>
      <td>${w.safe?'<span class="badge ok">safe</span>':'<span class="badge danger">unsafe</span>'}</td>
      <td class="muted">${w.note}</td>
    </tr>`).join("")}
    </tbody></table>
    <div class="notice info section-gap"><span class="ic">ℹ︎</span><div>An example of directly running an unsafe workflow → see <a href="#/run/run_313">run_313 (CredentialDenied)</a>.</div></div>
  </div>

  <div class="card section-gap" style="padding:0"><div class="card-head" style="padding:14px 16px 10px;margin:0;border-bottom:1px solid var(--border)"><h3>Credential decisions — per run</h3><span class="right badge accent">the enforcement, logged</span></div>
    <div style="padding:10px 16px 0" class="card-sub">STS <span class="mono">AssumeRole</span> is granted only to a <b>resumed + verified</b> run. This log is where bypass actually fails — no valid token ⇒ no cloud credential ⇒ no deploy.</div>
    <table class="tbl"><thead><tr><th>Run</th><th>Commit</th><th>Approval token</th><th>Verify</th><th>OIDC / STS decision</th></tr></thead><tbody>
    ${credentialDecisionRows()}
    </tbody></table>
    <div class="notice ok section-gap" style="margin:0 16px 14px"><span class="ic">✓</span><div><b>Trust condition holds</b> — every "granted" row had a valid token + passing verify; every "denied/withheld" row did not. Deleting the Verify step can't change this column.</div></div>
  </div>`;
}
// per-run credential outcome (STS granted / denied / withheld) — the enforcement made concrete
function credDecision(r){
  if(r.credential.denied) return ['danger','STS denied'];
  if(r.state==='Succeeded') return ['ok','STS granted'];
  if(r.state==='Rejected') return ['neutral','withheld — rejected'];
  if(r.state==='PendingApproval') return ['warn','withheld — awaiting resume'];
  if(r.state==='Blocked') return ['danger','STS denied'];
  if(r.state==='Failed') return ['ok','granted → failed later'];
  return ['neutral','—'];
}
function credentialDecisionRows(){
  return Object.values(M.runs).map(r=>{
    const [cls,label] = credDecision(r);
    const vcls = r.verify.ok?'ok':r.verify.fail?'danger':'warn';
    const vtxt = r.verify.ok?'pass':r.verify.fail?'fail':(r.verify.status||'—');
    return `<tr class="clickable" onclick="location.hash='#/run/${r.id}'">
      <td class="mono" style="font-size:12px">${r.id}</td>
      <td><span class="sha">${r.sha}</span></td>
      <td>${r.token?'<span class="badge neutral"><span class="dot"></span>token</span>':'<span class="muted">none</span>'}</td>
      <td><span class="badge ${vcls}">${vtxt}</span></td>
      <td><span class="badge ${cls}">${label}</span></td>
    </tr>`;
  }).join("");
}

/* ---------- Audit ---------- */
function hashHex(s){let h=2166136261>>>0;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return (h>>>0).toString(16).padStart(8,'0');}
function scAudit(){
  const ic = { user:"●", system:"⚙", "github-app":"❏" };
  // build hash chain in append order
  let prev="00000000"; const chained = M.audit.map(e=>{
    const h = hashHex(prev + e.day+e.ts+e.actor+e.action+e.env+e.sha+e.result+e.reason);
    const row = {...e, prev, hash:h}; prev=h; return row;
  });
  // group by day, display newest first
  const days = ["today","yesterday"];
  const groups = days.map(d=>({d, items: chained.filter(e=>e.day===d).reverse()})).filter(g=>g.items.length);
  return `
  <h1 class="page-title">Audit Log</h1>
  <p class="page-sub">append-only · hash-chain tamper-proof. Each entry's hash includes the previous hash.</p>
  <div class="row-flex wrap" style="margin-bottom:16px">
    <span class="badge ok"><span class="dot"></span>hash-chain verified (prev→curr chained)</span>
    <span class="badge neutral">Filter: all</span>
    <button class="btn ghost sm" onclick="proto('Configure SIEM/webhook streaming')">Configure streaming</button>
  </div>
  ${groups.map(g=>`
    <div class="card" style="margin-bottom:16px">
      <h3 style="margin-bottom:10px">${g.d}</h3>
      ${g.items.map(e=>`
      <div class="tl-item">
        <div><div class="ts">${e.ts}</div><div class="hash">${e.prev.slice(0,6)}→<b style="color:#52525b">${e.hash.slice(0,6)}</b></div></div>
        <div>
          <div class="row-flex" style="gap:8px"><span class="muted">${ic[e.type]||'●'}</span><b>${e.action}</b>
            ${e.result==='ok'?'<span class="badge ok">ok</span>':'<span class="badge danger">'+e.result+'</span>'}
            ${e.emph&&e.action==='approval.attempted'?'<span class="badge danger">self-approval blocked</span>':''}
            ${e.emph&&e.action==='emergency.override'?'<span class="badge danger">emergency · denied</span>':''}
          </div>
          <div class="muted" style="font-size:12.5px">${e.actor} · <span class="sha">${e.sha}</span>${e.reason?` · ${e.reason}`:''}</div>
        </div>
      </div>`).join("")}
    </div>`).join("")}`;
}

/* ---------- Settings ---------- */
let wizStep = 1;
function scSettings(){
  return `
  <h1 class="page-title">Settings</h1>
  <p class="page-sub">GitHub App integration · credential broker · org policy</p>
  <div class="grid cols-2">
    <div class="card"><h3>GitHub App</h3><div class="card-sub">Not a PAT — least privilege · rotation · survives departures</div>
      <div class="kv">
        <div class="k">installation</div><div>${M.repo.installation}</div>
        <div class="k">permissions</div><div>actions: write (dispatch) · contents: read</div>
        <div class="k">secrets write</div><div><span class="badge neutral">not requested</span></div>
      </div>
      <div class="row-flex section-gap"><span class="badge ok"><span class="dot"></span>Connected</span></div>
    </div>
    <div class="card"><h3>🔑 Cloud credential broker</h3><div class="card-sub">Core of enforcement — STS only for approved runs</div>
      <div class="kv">
        <div class="k">provider</div><div>${M.credentialBroker.provider}</div>
        ${M.credentialBroker.roles.map(r=>`<div class="k">role</div><div>${r.role} · ttl ${r.ttl}</div>`).join("")}
      </div>
      <div class="notice ok section-gap"><span class="ic">✓</span><div>OIDC trust configured — runs without a valid token are denied credentials.</div></div>
    </div>
  </div>
  <div class="card section-gap"><h3>Repo connect wizard</h3><div class="card-sub">Attach a new repo (mock)</div>
    <div class="wiz">
      <div class="s ${wizStep>=1?'active':''}"><b>1</b>Install App</div>
      <div class="s ${wizStep>=2?'active':''}"><b>2</b>Select repo</div>
      <div class="s ${wizStep>=3?'active':''}"><b>3</b>Detect .mocco.yml</div>
      <div class="s ${wizStep>=4?'active':''}"><b>4</b>OIDC trust</div>
    </div>
    <div class="row-flex">
      <button class="btn" onclick="wizStep=Math.max(1,wizStep-1);render()" ${wizStep<=1?'disabled':''}>← Back</button>
      <button class="btn primary" onclick="wizStep=Math.min(4,wizStep+1);render()" ${wizStep>=4?'disabled':''}>Next →</button>
      <span class="muted" style="font-size:12px">${["","Install the App on the repo","Select the repo to govern deploys for","Auto-parse & validate the repo's .mocco.yml","Configure cloud OIDC trust → done"][wizStep]}</span>
    </div>
  </div>
  <div class="card section-gap"><h3>Org policy override</h3><div class="card-sub">Repos can't weaken it (monotonic hardening)</div>
    <div class="kv">
      <div class="k">enforce_verify_action</div><div><span class="badge ok">true</span></div>
      <div class="k">enforce_oidc_gating</div><div><span class="badge ok">true</span></div>
      <div class="k">min_gate_resumers (prod gate)</div><div><b>2</b></div>
    </div>
    <div class="notice info section-gap"><span class="ic">ℹ︎</span><div>Equivalent to a GitLab compliance pipeline — an individual repo can't disable or bypass governance.</div></div>
  </div>`;
}

/* ---------- Repos (workspace management) ---------- */
function repoStatusBadge(s){
  const m={active:["ok","Connected"],setup:["warn","Setup needed"],paused:["neutral","Paused"]};
  const [cls,l]=m[s]||["neutral",s]; return `<span class="badge ${cls}"><span class="dot"></span>${l}</span>`;
}
function scRepos(){
  const byOrg={}; M.repos.forEach(r=>{ (byOrg[r.org]=byOrg[r.org]||[]).push(r); });
  const orgBlocks = M.orgs.map(o=>`
    <div class="card" style="padding:0">
      <div class="card-head" style="padding:12px 16px 10px;margin:0;border-bottom:1px solid var(--border)">
        <h3>◆ ${o.login}</h3>
        <span class="badge ${o.installed?'ok':'warn'}" style="margin-left:8px"><span class="dot"></span>App ${o.appId}</span>
        <button class="right btn ghost sm" onclick="proto('${o.login} — GitHub App settings')">Manage App</button>
      </div>
      <table class="tbl"><thead><tr><th>Repo</th><th>Status</th><th>.mocco.yml</th><th>Pipelines · gates</th><th>Last deploy</th><th></th></tr></thead><tbody>
      ${(byOrg[o.login]||[]).map(r=>`
        <tr class="clickable" onclick="proto('${r.owner}/${r.name} — repo settings')">
          <td><span class="author"><span style="color:var(--muted-foreground)">❏</span> <b>${r.name}</b></span></td>
          <td>${repoStatusBadge(r.status)}</td>
          <td>${r.moccoYml?'<span class="status-cell ok"><span class="sicon ok">✓</span>Detected</span>':'<span class="status-cell warn"><span class="sicon warn">!</span>None</span>'}</td>
          <td>${r.pipelines>0?`${r.pipelines} pipelines · ${r.gates} gates`:'<span class="muted">—</span>'}</td>
          <td>${r.lastDeploy?`<span class="sha">${r.lastDeploy.sha}</span> <span class="muted" style="font-size:12px">· ${r.lastDeploy.at}</span>`:'<span class="muted">—</span>'}</td>
          <td class="rowact"><button class="btn ghost sm" onclick="event.stopPropagation();proto('${r.name} ${r.status==='paused'?'resume':'settings'}')">${r.status==='paused'?'Resume':'⋯'}</button></td>
        </tr>`).join("")}
      </tbody></table>
    </div>`).join('<div class="section-gap"></div>');
  return `
  <div class="run-head">
    <div><h1 class="page-title">Repos</h1><p class="page-sub" style="margin:0">Workspace <b>${M.workspace.name}</b> · ${M.repos.length} connected repos · ${M.orgs.length} orgs</p></div>
    <div class="actions"><button class="btn primary" onclick="proto('Install GitHub App → repo select wizard')">＋ Connect repo</button></div>
  </div>
  <div class="notice info" style="margin-bottom:14px"><span class="ic">ℹ︎</span><div><b>Integration</b> = install GitHub App → select repo → detect <code>.mocco.yml</code> → OIDC trust. Many repos per org, many orgs per workspace.</div></div>
  ${orgBlocks}`;
}

/* ---------- Members · roles (workspace) ---------- */
function wsRoleBadge(role){
  const m={Owner:"accent",Admin:"info",Member:"neutral",Billing:"warn"};
  return `<span class="badge ${m[role]||'neutral'}">${role}</span>`;
}
function scMembers(){
  return `
  <div class="run-head">
    <div><h1 class="page-title">Members · roles</h1><p class="page-sub" style="margin:0">Workspace-level members & permissions for <b>${M.workspace.name}</b>. Deploy-approval roles (SRE · security) are assigned separately in <a href="#/access">Access</a>.</p></div>
    <div class="actions"><button class="btn primary" onclick="proto('Invite member — email/GitHub')">＋ Invite member</button></div>
  </div>
  <div class="card" style="padding:0">
    <table class="tbl"><thead><tr><th>Member</th><th>Email</th><th>GitHub</th><th>Workspace role</th><th></th></tr></thead><tbody>
    ${M.workspaceMembers.map(m=>`
      <tr>
        <td><span class="author">${avatar(m.initials)} <b>${m.name}</b></span></td>
        <td class="muted">${m.email}</td>
        <td class="mono" style="font-size:12px">${m.gh}</td>
        <td>${wsRoleBadge(m.wsRole)}</td>
        <td class="rowact"><button class="btn ghost sm" onclick="proto('Change role — ${m.name}')">Change role</button></td>
      </tr>`).join("")}
    </tbody></table>
  </div>
  <div class="card section-gap"><h3>Workspace roles</h3><div class="card-sub">WS role = admin rights (integrations · members · policy). Separate from deploy-approval rights.</div>
    ${M.wsRoles.map(r=>`<div class="rule"><div style="width:88px"><b>${r.role}</b></div><div style="flex:1" class="muted">${r.can}</div><span class="badge neutral">${r.count} people</span></div>`).join("")}
    <div class="notice info section-gap"><span class="ic">ℹ︎</span><div>Same spirit as <b>write ≠ deploy</b> — even a WS Admin can't approve deploys (that's a repo governance role). Admin rights and deploy rights stay separate.</div></div>
  </div>`;
}

/* ---------- Integrations ---------- */
function intStatus(s){ return s==="active"?'<span class="badge ok"><span class="dot"></span>Connected</span>':`<span class="badge neutral"><span class="dot"></span>${s}</span>`; }
function scIntegrations(){
  const g=M.integrations;
  return `
  <h1 class="page-title">Integrations</h1>
  <p class="page-sub">External integrations for workspace <b>${M.workspace.name}</b>. GitHub (identity · dispatch) · Cloud (OIDC credentials) · Slack (notifications).</p>

  <div class="card" style="padding:0"><div class="card-head" style="padding:14px 16px 10px;margin:0;border-bottom:1px solid var(--border)"><h3>◆ GitHub App</h3><span class="right muted" style="font-size:12px">Installed per org — dispatch · webhooks</span></div>
    <table class="tbl"><thead><tr><th>Org</th><th>App</th><th>Repos</th><th>Permission scope</th><th>Status</th><th></th></tr></thead><tbody>
    ${g.github.map(x=>`<tr><td><b>${x.org}</b></td><td class="mono" style="font-size:12px">${x.appId}</td><td>${x.repos}</td><td class="muted" style="font-size:12px">${x.scopes}</td><td>${intStatus(x.status)}</td><td class="rowact"><button class="btn ghost sm" onclick="proto('${x.org} App settings')">Settings</button></td></tr>`).join("")}
    </tbody></table>
    <div class="row-flex" style="padding:12px 16px"><button class="btn" onclick="proto('Install App on a GitHub org')">＋ Connect org</button></div>
  </div>

  <div class="grid cols-2 section-gap">
    <div class="card"><h3>🔑 Cloud (OIDC)</h3><div class="card-sub">Credential broker — the real core of enforcement</div>
      ${g.cloud.map(c=>`<div class="rule"><div style="flex:1"><b>${c.provider}</b><div class="muted" style="font-size:12px">${c.roles.length?('roles: '+c.roles.join(", ")):'no roles'}${c.trust!=='—'?' · trust: '+c.trust:''}</div></div>${intStatus(c.status)}</div>`).join("")}
      <div class="notice info section-gap"><span class="ic">ℹ︎</span><div>STS issued only to gate-resumed runs. <a href="#/verify">How enforcement works →</a></div></div>
    </div>
    <div class="card"><div class="card-head"><h3>💬 Slack <span class="later-pill">post-MVP</span></h3><span class="right">${intStatus(g.slack.status)}</span></div>
      <div class="kv">
        <div class="k">workspace</div><div>${g.slack.workspace}</div>
        <div class="k">channel</div><div class="mono">${g.slack.channel}</div>
        <div class="k">events</div><div>${g.slack.events.map(e=>`<span class="badge neutral" style="margin:2px 3px 0 0">${e}</span>`).join("")}</div>
      </div>
      <div class="row-flex" style="margin-top:12px"><button class="btn" onclick="proto('Edit Slack notification events')">Edit events</button></div>
    </div>
  </div>`;
}

/* ---------- router ---------- */
function render(){
  const hash = location.hash || "#/";
  let html, active = hash;
  if (hash.startsWith("#/run/")) { html = scRun(hash.split("/")[2]); active = "#/queue"; }
  else switch(hash){
    case "#/": html = scQueue(); active = "#/queue"; break;   // home = Deploy Queue
    case "#/queue": html = scQueue(); break;
    case "#/access": html = scAccess(); break;
    case "#/policy": html = scPolicy(); break;
    // Concurrency and Verify are folded into Pipelines & Gates tabs — nav highlights Pipelines
    case "#/concurrency": html = scConcurrency(); active = "#/policy"; break;
    case "#/verify": html = scVerify(); active = "#/policy"; break;
    case "#/audit": html = scAudit(); break;
    case "#/settings": html = scSettings(); break;
    case "#/repos": html = scRepos(); break;
    case "#/members": html = scMembers(); break;
    case "#/integrations": html = scIntegrations(); break;
    default:
      html = scQueue(); active = "#/queue";
  }
  $("#content").innerHTML = `<div class="content-inner">${html}</div>`;
  document.querySelectorAll(".nav-item").forEach(n=>n.classList.toggle("active", n.dataset.route===active));
  const titles = {"#/queue":"Deploy Queue","#/access":"Access","#/policy":"Pipelines & Gates","#/audit":"Audit Log","#/settings":"Settings","#/repos":"Repos","#/members":"Members","#/integrations":"Integrations"};
  $("#crumbs").innerHTML = `Mocco · <b>${hash.startsWith("#/run/")?"Run detail":titles[active]||"Deploy Queue"}</b>`;
  document.body.classList.remove("nav-open");   // close the mobile drawer on navigation
  $("#content").scrollTop = 0;   // app-shell: only the content scrolls, not the document
}

/* ---------- context switchers (workspace / repo) ---------- */
function renderRepoMenu(){
  return M.repos.map(r=>{
    const active = r.owner===M.repo.owner && r.name===M.repo.name;
    return `<button class="repo-opt ${active?'active':''}" type="button" role="option" data-owner="${r.owner}" data-name="${r.name}">
      <span class="ico">${svg('repo')}</span>${r.owner}/${r.name}${active?'<span class="check">✓</span>':''}</button>`;
  }).join("") + `<a class="repo-opt add" href="#/repos"><span class="ico">＋</span>Connect repo…</a>`;
}
function renderWsMenu(){
  return M.workspaces.map(w=>{
    const active = w.slug===M.workspace.slug;
    return `<button class="repo-opt ${active?'active':''}" type="button" role="option" data-name="${w.name}" data-slug="${w.slug}">
      <span class="ico">${svg('workspace')}</span>${w.name}${active?'<span class="check">✓</span>':''}</button>`;
  }).join("") + `<a class="repo-opt add" href="#/members"><span class="ico">＋</span>Manage workspace…</a>`;
}
function setupSwitch(sw, btn, menu, renderMenu, onPick){
  const close=()=>{ menu.hidden=true; btn.setAttribute("aria-expanded","false"); };
  const open=()=>{ menu.innerHTML=renderMenu(); menu.hidden=false; btn.setAttribute("aria-expanded","true"); };
  btn.addEventListener("click", e=>{ e.stopPropagation(); menu.hidden?open():close(); });
  menu.addEventListener("click", e=>{
    const opt=e.target.closest(".repo-opt"); if(!opt) return;
    if(!opt.classList.contains("add")){ e.preventDefault(); onPick(opt); }
    close();   // add(<a>) follows the link; a selection closes after onPick
  });
  document.addEventListener("click", e=>{ if(!sw.contains(e.target)) close(); });
}
function setupSwitchers(){
  setupSwitch($("#repoSwitch"), $("#repoBtn"), $("#repoMenu"), renderRepoMenu, opt=>{
    M.repo.owner=opt.dataset.owner; M.repo.name=opt.dataset.name;
    $("#repoLabel").textContent = `${M.repo.owner}/${M.repo.name}`;
    render(); toast(`Switched repo: ${M.repo.owner}/${M.repo.name} (mock — data unchanged)`);
  });
  setupSwitch($("#wsSwitch"), $("#wsBtn"), $("#wsMenu"), renderWsMenu, opt=>{
    M.workspace.name=opt.dataset.name; M.workspace.slug=opt.dataset.slug;
    $("#wsLabel").textContent = M.workspace.name;
    render(); toast(`Switched workspace: ${M.workspace.name} (mock)`);
  });
}
function renderNav(){
  return NAV.map(n=>{
    if(n.group) return `<div class="nav-group-label">${n.group}</div>`;
    return `<a class="nav-item ${n.soon?'disabled':''}" data-route="${n.route}" href="${n.soon?'#':n.route}" title="${n.label}">
      <span class="ico">${svg(n.ico)}</span>${n.label}${n.soon?'<span class="soon">soon</span>':''}</a>`;
  }).join("");
}
document.addEventListener("DOMContentLoaded", ()=>{
  $("#nav").innerHTML = renderNav();
  setupSwitchers();
  const isMobile = ()=> window.matchMedia("(max-width: 768px)").matches;
  $("#navToggle").addEventListener("click", ()=>{
    // desktop: toggle the narrow icon rail / mobile: toggle the drawer (overlay)
    document.body.classList.toggle(isMobile() ? "nav-open" : "nav-collapsed");
  });
  const backdrop = $("#navBackdrop");
  if (backdrop) backdrop.addEventListener("click", ()=> document.body.classList.remove("nav-open"));
  window.addEventListener("hashchange", render);
  render();
});
