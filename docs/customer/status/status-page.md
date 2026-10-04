---
title: Run a status page
description: Create a status page for a project, list the parts of your service as components, declare incidents and post updates as they move from investigating to resolved, write a postmortem, and schedule maintenance that Mocco starts and ends on time.
type: guide
status: active
created: 2026-10-05
updated: 2026-10-05
confidence: high
owner: andrea
tags: [customer, status, incidents, maintenance, guide]
related:
  - ../../reference/status.md
---

# Run a status page

A status page tells your users whether your service works. You list the parts of your service as **components**, report **incidents** against them while something is wrong, and announce **maintenance** before you do it. Mocco works out what each component shows from what you report.

The page is managed from the console today. The public page your users open comes later.

## 1. Turn on the status page

A workspace member turns on **Status page** on the workspace's **Products** page. Each project then shows a **Status page** section.

## 2. Create a page

On the project's **Status page** section, give the page a **title** and an **address**. Mocco suggests the address from the title; it becomes the public page's address, so it must be unique across Mocco and use lowercase letters, digits and hyphens.

![Creating a status page: a title and its address](./images/create-page.png)

A project can have more than one page, for example one for customers and one for your own team. Choose **New page** to add another; each page is a tab.

## 3. List your components

Under **Components**, add each part of your service your users would notice: your API, your web app, push notifications. Put related components in a **group** ("API", "Dashboard") so the page stays readable. Use the arrows to change the order, **Edit** to rename a component, describe it or move it to another group, and **Delete** to remove it.

![Components grouped under Dashboard and API, each with the status it shows and the status reported by hand](./images/components.png)

Each component has two statuses:

- **Reported status** is what you set by hand: Operational, Under maintenance, Degraded performance, Partial outage or Major outage.
- The **badge** next to the name is what the page shows. It is the worst of the reported status, the impact of any open incident on the component, and "Under maintenance" while a maintenance window covering it is in progress. An outage during maintenance still shows as an outage. When an incident or maintenance makes a component show worse than you reported, the row says so.

You rarely need to change the reported status yourself: declare an incident instead, and the component goes back to operational when the incident is resolved.

**Page settings**, below the components, rename the page or change its address. **Delete page** deletes the page with its components, incidents and maintenance windows.

## 4. Declare an incident

Open the **Incidents** tab. It lists the **Open** incidents; **Resolved** lists the closed ones. Both lists keep their place in the link, so you can share them.

![The open incidents of a page](./images/incidents.png)

Choose **Declare incident** and fill in:

- **Title**: what your users notice, such as "Delayed push notifications".
- **Severity**: Minor, Major or Critical.
- **Status**: where you are. Most incidents start at **Investigating**; pick **Identified** or **Monitoring** if you already know more.
- **First update**: the first message on the incident's timeline.
- **Affected components**: for each component the incident touches, how badly: degraded performance, partial outage or major outage.

![Declaring an incident with its severity, first update and the components it affects](./images/declare.png)

## 5. Post updates until it's resolved

Open an incident to see its timeline, newest first, and to post an update. Each update has a message and a status. The status list offers only the steps an incident can take from where it is:

| From | To |
|---|---|
| Investigating | Identified, Monitoring or Resolved |
| Identified | Monitoring or Resolved |
| Monitoring | Identified (the fix didn't hold) or Resolved |
| Resolved | Nothing: a resolved incident is closed |

Keep the current status, marked "(no change)", to post news without moving the incident. **Change** under **Affected components** updates which components are affected and how badly, for example when an outage spreads or eases.

![An incident in Monitoring with its timeline and affected components](./images/incident.png)

If someone else moved the incident while you were writing, for example resolved it in another tab, Mocco refuses the update, says why, and shows the incident as it is now.

![An update refused because the incident was resolved in the meantime](./images/update-refused.png)

## 6. Write the postmortem

Once the incident is over, write what happened, why, and what you changed in **Postmortem**. It is Markdown. Leave it empty and save to remove it.

![A resolved incident with its full timeline and postmortem](./images/postmortem.png)

## 7. Schedule maintenance

Open the **Maintenance** tab and choose **Schedule maintenance**. Give the window a title, when it starts and ends (in your time zone), optional details, and the components it covers.

![Scheduling a maintenance window for the API components](./images/schedule-maintenance.png)

Mocco starts each window at its start time and completes it at its end, checking every minute. The tab shows what is **In progress**, what is **Scheduled**, and the **Past** windows. While a window is in progress, the components it covers show "Under maintenance".

![A window in progress, one scheduled and one canceled](./images/maintenance.png)

To call a window off, choose **Cancel**; a window that is already in progress ends at once. Windows can't be edited: cancel the window and schedule a new one.

## What gets recorded

Creating and deleting pages, changing a component's reported status, declaring incidents, posting updates, changing affected components or the postmortem, and scheduling, canceling, starting and completing maintenance are all written to the workspace's [audit log](../start/audit-log.md).
