// Renders a public snapshot as the static status page and its Atom feed (ADR 0028). Plain HTML
// and CSS that show the current state without JavaScript; a small script localizes times and,
// while the tab is visible, polls `current.json` and swaps in the version it names. Every piece
// of customer text goes through `escapeHtml`.
import { ComponentStatuses, IncidentStatuses, MaintenanceStatuses } from '@mocco/common/status';

import type { PublicIncident, PublicSnapshot } from '@backend/domain/status/snapshot/format';
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
.desc,.meta,footer{color:var(--muted);font-size:13px}.bars{display:flex;gap:2px;margin-top:8px;height:24px}.bars span{flex:1;border-radius:2px;background:var(--nodata)}
.status{font-size:13px;font-weight:600;white-space:nowrap}.card{border:1px solid var(--line);border-radius:8px;padding:16px;margin-bottom:12px}
.card h3{margin:0 0 4px;font-size:16px}.update{margin-top:12px}.update p{margin:2px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}
footer{margin-top:40px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}a{color:inherit}
`;

const statusColor = (status: ComponentStatus) => `var(--${status})`;

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

const NO_DATA_BARS = `<div class="bars" title="Uptime history: no data yet" aria-label="Uptime history: no data yet">${'<span></span>'.repeat(90)}</div><div class="line meta"><span>90 days ago</span><span>No data yet</span><span>Today</span></div>`;

function renderComponent(component: PublicSnapshot['sections'][number]['components'][number]): string {
  const description =
    component.description === null ? '' : `<div class="desc">${escapeHtml(component.description)}</div>`;
  const label = `<span class="status" style="color:${statusColor(component.status)}">${COMPONENT_LABELS[component.status]}</span>`;
  return `<div class="row"><div class="line"><span>${escapeHtml(component.name)}</span>${label}</div>${description}${NO_DATA_BARS}</div>`;
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

const incidentList = (incidents: readonly PublicIncident[]) =>
  incidents.map(incident => renderIncident(incident)).join('');

/** The page's script: localize times, then poll the pointer while the tab is visible. */
function script(root: string, version: number): string {
  return `(function(){var root=${JSON.stringify(root)},version=${version};
function localize(){document.querySelectorAll('time[datetime]').forEach(function(el){var d=new Date(el.getAttribute('datetime'));if(!isNaN(d))el.textContent=d.toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});});}
function poll(){if(document.visibilityState!=='visible')return;fetch(root+'current.json',{cache:'no-cache'}).then(function(r){return r.ok?r.json():null;}).then(function(p){if(!p||typeof p.version!=='number'||p.version===version)return null;return fetch(root+'v/'+p.version+'/index.html').then(function(r){return r.ok?r.text():null;}).then(function(html){if(!html)return;var next=new DOMParser().parseFromString(html,'text/html').querySelector('main');if(!next)return;document.querySelector('main').replaceWith(next);version=p.version;localize();});}).catch(function(){});}
localize();setInterval(poll,30000);document.addEventListener('visibilitychange',poll);})();`;
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
    `<h2>Past incidents</h2>${history}`,
  ].join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><link rel="alternate" type="application/atom+xml" title="${title}" href="${root}feed.atom"><style>${STYLE}</style></head>
<body><main data-version="${snapshot.version}"><h1>${title}</h1><div class="banner" style="background:${statusColor(snapshot.status)}">${OVERALL_LABELS[snapshot.status]}</div>${sections}
<footer><span>Updated ${time(snapshot.builtAt)}</span><a href="${root}feed.atom">Atom feed</a></footer></main>
<script>${script(root, snapshot.version)}</script></body></html>
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
