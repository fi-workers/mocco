// Renders a public snapshot as the static status page and its Atom feed (ADR 0028). Plain HTML
// and CSS that show the current state without JavaScript; a small script localizes times and,
// while the tab is visible, polls `current.json` and swaps in the version it names. Every piece
// of customer text goes through `escapeHtml`.
//
// The sign-up form (#156) is the page's only call to the app. It is a plain form that posts
// without the script (the app answers with a page); with the script it posts in the background
// and says how it went in place. Either way a failure only changes the form's message: nothing
// else on the page depends on it.
import { ComponentStatuses, IncidentStatuses, MaintenanceStatuses } from '@mocco/common/status';

import type { PublicIncident, PublicSnapshot, PublicUptimeDay } from '@backend/domain/status/snapshot/format';
import type { ComponentStatus, IncidentStatus } from '@mocco/common/status';

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape text for HTML or XML content and attribute values. */
export function escapeHtml(value: string): string {
  // eslint-disable-next-line sonarjs/null-dereference -- value is a string, never null
  return value.replaceAll(/[&<>"']/gu, (char: string) => ESCAPES[char] ?? char);
}

const COMPONENT_LABELS: Record<ComponentStatus, string> = {
  [ComponentStatuses.operational]: 'Operational',
  [ComponentStatuses.maintenance]: 'Under maintenance',
  [ComponentStatuses.degraded]: 'Degraded performance',
  [ComponentStatuses.partialOutage]: 'Partial outage',
  [ComponentStatuses.majorOutage]: 'Major outage',
};

const OVERALL_LABELS: Record<ComponentStatus, string> = {
  [ComponentStatuses.operational]: 'All systems operational',
  [ComponentStatuses.maintenance]: 'Maintenance in progress',
  [ComponentStatuses.degraded]: 'Some systems are degraded',
  [ComponentStatuses.partialOutage]: 'Partial outage',
  [ComponentStatuses.majorOutage]: 'Major outage',
};

const INCIDENT_LABELS: Record<IncidentStatus, string> = {
  [IncidentStatuses.investigating]: 'Investigating',
  [IncidentStatuses.identified]: 'Identified',
  [IncidentStatuses.monitoring]: 'Monitoring',
  [IncidentStatuses.resolved]: 'Resolved',
};

const UTC_FORMAT = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

/** A `<time>` in UTC; the page's script rewrites it in the visitor's time zone. */
function time(iso: string): string {
  return `<time datetime="${escapeHtml(iso)}">${escapeHtml(UTC_FORMAT.format(new Date(iso)))} UTC</time>`;
}

const STYLE = `
:root{--bg:#fff;--fg:#111827;--muted:#6b7280;--line:#e5e7eb;--card:#f9fafb;--operational:#16a34a;--maintenance:#2563eb;--degraded:#ca8a04;--partial_outage:#ea580c;--major_outage:#dc2626;--nodata:#e5e7eb}
@media (prefers-color-scheme:dark){:root{--bg:#0b0f14;--fg:#e5e7eb;--muted:#9ca3af;--line:#1f2937;--card:#111827;--nodata:#1f2937}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 16px 48px}h1{font-size:24px;margin:0 0 20px}h2{font-size:17px;margin:32px 0 12px}
.banner{border-radius:8px;padding:16px;color:#fff;font-weight:600;font-size:17px}
.list{border:1px solid var(--line);border-radius:8px;overflow:hidden}.row{padding:12px 16px;border-top:1px solid var(--line)}.row:first-child{border-top:0}
.group{background:var(--card);font-weight:600}.line{display:flex;justify-content:space-between;gap:12px;align-items:baseline}
.desc,.meta,footer{color:var(--muted);font-size:13px}.bars{display:flex;gap:2px;margin:8px 0 0;padding:0;list-style:none;height:24px}.bars li{flex:1;border-radius:2px;background:var(--nodata)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.status{font-size:13px;font-weight:600;white-space:nowrap}.card{border:1px solid var(--line);border-radius:8px;padding:16px;margin-bottom:12px}
.card h3{margin:0 0 4px;font-size:16px}.update{margin-top:12px}.update p{margin:2px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}
footer{margin-top:40px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}a{color:inherit}
.subscribe .field{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}.subscribe input[type=email]{flex:1 1 220px;min-width:0;font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
.subscribe button{font:inherit;font-weight:600;padding:8px 14px;border:0;border-radius:6px;background:var(--fg);color:var(--bg);cursor:pointer}.subscribe button:disabled{opacity:.6}
.subscribe fieldset{border:0;margin:8px 0 0;padding:0}.subscribe details{margin-top:8px}.subscribe .choice{display:block;font-size:14px}
.hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}
`;

const statusColor = (status: ComponentStatus) => `var(--${status})`;

type PublicComponent = PublicSnapshot['sections'][number]['components'][number];

/** One line of details, separated by middle dots; empty parts are dropped. */
const details = (parts: readonly string[]) =>
  `<div class="meta">${parts.filter(part => part !== '').join(' · ')}</div>`;

const names = (components: readonly { name: string }[]) =>
  components.map(component => escapeHtml(component.name)).join(', ');

const paragraph = (body: string) => (body === '' ? '' : `<div class="update"><p>${escapeHtml(body)}</p></div>`);

function renderIncident(incident: PublicIncident): string {
  const updates = incident.updates
    .map(
      update =>
        `<div class="update"><strong>${INCIDENT_LABELS[update.status]}</strong> <span class="meta">${time(update.at)}</span><p>${escapeHtml(update.body)}</p></div>`,
    )
    .join('');
  const resolved = incident.resolvedAt === null ? '' : `resolved ${time(incident.resolvedAt)}`;
  const meta = details([
    INCIDENT_LABELS[incident.status],
    `started ${time(incident.startedAt)}`,
    resolved,
    names(incident.components),
  ]);
  return `<article class="card" id="incident-${escapeHtml(incident.key)}"><h3>${escapeHtml(incident.title)}</h3>${meta}${updates}</article>`;
}

const DAY_FORMAT = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });

// eslint-disable-next-line sonarjs/null-dereference -- percent is a number, never null
const percentText = (percent: number) => `${percent.toFixed(2)}% uptime`;

/** One day's bar: its colour is the worst status that day, and its text (a tooltip, and read by
 * screen readers and text browsers) names the day, the status and the uptime. */
function renderBar(bar: PublicUptimeDay): string {
  const date = DAY_FORMAT.format(new Date(`${bar.day}T00:00:00.000Z`));
  const text =
    bar.status === null
      ? `${date}: no data`
      : [date, COMPONENT_LABELS[bar.status], ...(bar.uptime === null ? [] : [percentText(bar.uptime)])].join(' · ');
  const color = bar.status === null ? '' : ` style="background:${statusColor(bar.status)}"`;
  return `<li title="${escapeHtml(text)}"${color}><span class="sr">${escapeHtml(text)}</span></li>`;
}

function renderBars(uptime: PublicComponent['uptime']): string {
  const summary = uptime.percent === null ? 'No uptime data yet' : percentText(uptime.percent);
  return `<ol class="bars" aria-label="Uptime history, last ${uptime.days.length} days">${uptime.days.map(bar => renderBar(bar)).join('')}</ol><div class="line meta"><span>${uptime.days.length} days ago</span><span>${summary}</span><span>Today</span></div>`;
}

function renderComponent(component: PublicComponent): string {
  const description =
    component.description === null ? '' : `<div class="desc">${escapeHtml(component.description)}</div>`;
  const label = `<span class="status" style="color:${statusColor(component.status)}">${COMPONENT_LABELS[component.status]}</span>`;
  return `<div class="row"><div class="line"><span>${escapeHtml(component.name)}</span>${label}</div>${description}${renderBars(component.uptime)}</div>`;
}

function renderComponents(snapshot: PublicSnapshot): string {
  const rows = snapshot.sections.flatMap(section => [
    ...(section.name === null ? [] : [`<div class="row group">${escapeHtml(section.name)}</div>`]),
    ...section.components.map(component => renderComponent(component)),
  ]);
  return rows.length === 0 ? '' : `<div class="list">${rows.join('')}</div>`;
}

function renderMaintenance(window: PublicSnapshot['maintenances'][number]): string {
  const meta = details([
    window.status === MaintenanceStatuses.inProgress ? 'In progress' : 'Scheduled',
    `${time(window.scheduledStart)} to ${time(window.scheduledEnd)}`,
    names(window.components),
  ]);
  return `<article class="card"><h3>${escapeHtml(window.title)}</h3>${meta}${paragraph(window.body)}</article>`;
}

/** What the form says before and after a sign-up; the script writes the last three. */
const SUBSCRIBE_TEXT = {
  hint: "We'll email you a link to confirm. Or follow the",
  sending: 'Signing you up…',
  done: 'Check your inbox: we sent you a link to confirm your subscription.',
  invalid: 'Check the address and try again.',
  failed: "We couldn't sign you up right now. Try again later.",
} as const;

/** The sign-up form: email, optionally the components to hear about, and a honeypot field people
 * never see (`website`). */
function renderSubscribe(snapshot: PublicSnapshot, root: string): string {
  if (snapshot.subscribe === null) {
    return '';
  }
  const components = snapshot.sections.flatMap(section => section.components);
  const choices =
    components.length < 2
      ? ''
      : `<details><summary>Only some components</summary><fieldset><legend class="sr">Components</legend>${components
          .map(
            component =>
              `<label class="choice"><input type="checkbox" name="componentIds" value="${escapeHtml(component.id)}"> ${escapeHtml(component.name)}</label>`,
          )
          .join('')}</fieldset></details>`;
  return `<h2 id="subscribe">Get updates</h2><form class="card subscribe" method="post" action="${escapeHtml(snapshot.subscribe.url)}" data-subscribe>
<label for="subscribe-email">Email address</label><div class="field"><input id="subscribe-email" name="email" type="email" required autocomplete="email" maxlength="254" placeholder="you@example.com"><button type="submit">Subscribe</button></div>
<div class="hp" aria-hidden="true"><label for="subscribe-website">Website</label><input id="subscribe-website" name="website" tabindex="-1" autocomplete="off"></div>${choices}
<p class="meta" role="status" aria-live="polite" data-subscribe-status>${escapeHtml(SUBSCRIBE_TEXT.hint)} <a href="${root}feed.atom">Atom feed</a>.</p></form>`;
}

const incidentList = (incidents: readonly PublicIncident[]) =>
  incidents.map(incident => renderIncident(incident)).join('');

/** The page's script: localize times, poll the pointer while the tab is visible (never swapping the
 * page while someone is typing an address), and post the sign-up form in the background. */
export function pageScript(root: string, version: number): string {
  const text = JSON.stringify(SUBSCRIBE_TEXT);
  return `(function(){var root=${JSON.stringify(root)},version=${version},text=${text};
function localize(){document.querySelectorAll('time[datetime]').forEach(function(el){var d=new Date(el.getAttribute('datetime'));if(!isNaN(d))el.textContent=d.toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});});}
function typing(){var el=document.querySelector('[data-subscribe] input[name=email]');return !!el&&(el.value!==''||document.activeElement===el);}
function poll(){if(document.visibilityState!=='visible'||typing())return;fetch(root+'current.json',{cache:'no-cache'}).then(function(r){return r.ok?r.json():null;}).then(function(p){if(!p||typeof p.version!=='number'||p.version===version)return null;return fetch(root+'v/'+p.version+'/index.html').then(function(r){return r.ok?r.text():null;}).then(function(html){if(!html)return;var next=new DOMParser().parseFromString(html,'text/html').querySelector('main');if(!next)return;document.querySelector('main').replaceWith(next);version=p.version;localize();});}).catch(function(){});}
function subscribe(e){var form=e.target;if(!form||!form.hasAttribute||!form.hasAttribute('data-subscribe')||typeof fetch!=='function'||typeof URLSearchParams!=='function'||typeof FormData!=='function')return;e.preventDefault();var status=form.querySelector('[data-subscribe-status]'),button=form.querySelector('button');function say(t){if(status)status.textContent=t;}
if(button)button.disabled=true;say(text.sending);
fetch(form.action,{method:'POST',headers:{Accept:'application/json'},body:new URLSearchParams(new FormData(form))}).then(function(r){if(r.status===202){form.reset();say(text.done);}else{say(r.status===400?text.invalid:text.failed);}},function(){say(text.failed);}).then(function(){if(button)button.disabled=false;});}
localize();setInterval(poll,30000);document.addEventListener('visibilitychange',poll);document.addEventListener('submit',subscribe);})();`;
}

/**
 * The status page. `root` is the relative path from the file to the page's directory: `''` for
 * `/{slug}/index.html`, `'../../'` for the immutable copy at `/{slug}/v/{version}/index.html`.
 */
export function renderStatusPage(snapshot: PublicSnapshot, root: '' | '../../'): string {
  const title = escapeHtml(snapshot.page.title);
  const maintenances = snapshot.maintenances.map(window => renderMaintenance(window)).join('');
  const history =
    snapshot.history.length === 0 ? '<p class="meta">No incidents reported.</p>' : incidentList(snapshot.history);
  const sections = [
    snapshot.incidents.length === 0 ? '' : `<h2>Active incidents</h2>${incidentList(snapshot.incidents)}`,
    maintenances === '' ? '' : `<h2>Maintenance</h2>${maintenances}`,
    `<h2>Components</h2>${renderComponents(snapshot)}`,
    renderSubscribe(snapshot, root),
    `<h2>Past incidents</h2>${history}`,
  ].join('');
  const subscribeLink = snapshot.subscribe === null ? '' : '<a href="#subscribe">Get updates</a>';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><link rel="alternate" type="application/atom+xml" title="${title}" href="${root}feed.atom"><style>${STYLE}</style></head>
<body><main data-version="${snapshot.version}"><h1>${title}</h1><div class="banner" style="background:${statusColor(snapshot.status)}">${OVERALL_LABELS[snapshot.status]}</div>${sections}
<footer><span>Updated ${time(snapshot.builtAt)}</span><span>${subscribeLink} <a href="${root}feed.atom">Atom feed</a></span></footer></main>
<script>${pageScript(root, snapshot.version)}</script></body></html>
`;
}

/** The Atom feed: one entry per incident update, newest first. Links are relative to the page. */
export function renderAtomFeed(snapshot: PublicSnapshot): string {
  const entries = [...snapshot.incidents, ...snapshot.history]
    .flatMap(incident =>
      incident.updates.map((update, index) => ({ incident, update, n: incident.updates.length - index })),
    )
    .toSorted((a, b) => b.update.at.localeCompare(a.update.at))
    .slice(0, 50)
    .map(({ incident, update, n }) => {
      const entryTitle = escapeHtml(`${incident.title}: ${INCIDENT_LABELS[update.status]}`);
      return `<entry><id>tag:mocco,2026:status/${escapeHtml(snapshot.page.slug)}/${incident.key}/${n}</id>
<title>${entryTitle}</title><updated>${update.at}</updated>
<link rel="alternate" href="index.html#incident-${incident.key}"/><content type="text">${escapeHtml(update.body)}</content></entry>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><id>tag:mocco,2026:status/${escapeHtml(snapshot.page.slug)}</id>
<title>${escapeHtml(snapshot.page.title)}</title><updated>${snapshot.builtAt}</updated><author><name>${escapeHtml(snapshot.page.title)}</name></author>
<link rel="alternate" href="index.html"/>
${entries}
</feed>
`;
}
