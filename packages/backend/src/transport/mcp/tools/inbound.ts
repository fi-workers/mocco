// `mocco_inbound_sources_search` — which webhook sources a workspace has (Sentry, Vercel,
// GitHub), whether each accepts deliveries, and when it last received one. Read-only:
// creating a source, rotating its secret, pausing and deleting it change what reaches a
// team, and a tool that does them needs the deciding machinery and its own design pass.
//
// A thin adapter (ADR 0025) over the inbound domain the console's `inbound` router reads
// through: `SourceService.list` for the sources and, in the detailed shape,
// `InboundService.listReceipts` for each one's latest receipt. Sources are
// workspace-level, so the call first goes through `WorkspaceScope` with the caller's own
// id; listing them needs membership only, as in the console.
//
// The signing secret never leaves the service (`SourceService` projects it to
// `hasSecret`), and the answer is built field by field, so nothing added to the row later
// can ride along. The ingest URL is in the detailed shape only: it names the source and
// is what the vendor is configured with, but it is no credential — every delivery must
// also carry a valid signature (ADR 0019).
import { InboundKinds, InboundSourceStatuses } from '@mocco/common/inbound';
import { z } from 'zod';

import { ToolUnavailableError } from '@backend/domain/mcp/errors';
import { pageOf } from '@backend/transport/mcp/tools/notifications';
import { asJson, userIdOf, workspaceArg } from '@backend/transport/mcp/tools/runs';

import type { InboundService } from '@backend/domain/inbound/InboundService';
import type { SourceService } from '@backend/domain/inbound/SourceService';
import type { WorkspaceScope } from '@backend/domain/mcp/WorkspaceScope';
import type { InboundKind, InboundSourceStatus } from '@mocco/common/inbound';
import type { McpServer } from '@modelcontextprotocol/server';

export interface InboundToolDeps {
  /** Absent when the server has no `SECRETS_ENCRYPTION_KEYS`; the tool then says so. */
  inbound?: {
    sources: Pick<SourceService, 'list'>;
    inbound: Pick<InboundService, 'listReceipts'>;
  };
  scope: Pick<WorkspaceScope, 'resolve'>;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const kinds = Object.values(InboundKinds) as [InboundKind, ...InboundKind[]];
const statuses = Object.values(InboundSourceStatuses) as [InboundSourceStatus, ...InboundSourceStatus[]];

const sourcesInput = z.object({
  workspaceId: workspaceArg,
  kind: z.enum(kinds).optional().describe('Only sources of this service.'),
  status: z
    .enum(statuses)
    .optional()
    .describe('Only `active` sources, or only `paused` ones (a paused source refuses deliveries).'),
  query: z.string().min(1).optional().describe('Text the source name contains (case-insensitive).'),
  limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  after: z.string().optional().describe("Cursor: the previous answer's `nextAfter`, as it was given."),
  responseFormat: z
    .enum(['concise', 'detailed'])
    .default('concise')
    .describe(
      "`concise` is id, service, name, status and when it last received a delivery; `detailed` adds the latest delivery's outcome, whether a signing secret is stored, the ingest URL the service is configured with, and when the source was created.",
    ),
});

export type SearchInboundSourcesArgs = z.infer<typeof sourcesInput>;

export async function searchInboundSources(deps: InboundToolDeps, args: SearchInboundSourcesArgs, userId: string) {
  if (deps.inbound === undefined) {
    throw new ToolUnavailableError(
      'Inbound webhooks are not configured on this Mocco server: it needs SECRETS_ENCRYPTION_KEYS set',
    );
  }
  const { sources, inbound } = deps.inbound;
  const workspaceId = await deps.scope.resolve(userId, args.workspaceId);
  const needle = args.query?.toLowerCase();
  const listed = await sources.list(workspaceId);
  const matching = listed.filter(
    source =>
      (args.kind === undefined || source.kind === args.kind) &&
      (args.status === undefined || source.status === args.status) &&
      (needle === undefined || source.name.toLowerCase().includes(needle)),
  );
  const { rows, ...more } = pageOf(matching, args);

  const isDetailed = args.responseFormat === 'detailed';
  // The newest receipt of each source on the page, read only when the detail is asked for.
  const latest = new Map(
    isDetailed
      ? await Promise.all(
          rows.map(async source => {
            const { receipts } = await inbound.listReceipts(workspaceId, { sourceId: source.id, limit: 1 });
            return [source.id, receipts[0]] as const;
          }),
        )
      : [],
  );
  return {
    sources: rows.map(source => {
      const receipt = latest.get(source.id);
      return {
        id: source.id,
        kind: source.kind,
        name: source.name,
        status: source.status,
        lastReceivedAt: source.lastReceivedAt,
        ...(isDetailed && {
          lastDelivery:
            receipt === undefined
              ? null
              : {
                  receivedAt: receipt.receivedAt,
                  outcome: receipt.outcome,
                  reason: receipt.reason,
                  sourceEvent: receipt.sourceEvent,
                  eventType: receipt.eventType,
                },
          hasSecret: source.hasSecret,
          ingestUrl: source.ingestUrl,
          createdAt: source.createdAt,
          updatedAt: source.updatedAt,
        }),
      };
    }),
    ...more,
  };
}

export function registerInboundTools(server: McpServer, deps: InboundToolDeps): void {
  server.registerTool(
    'mocco_inbound_sources_search',
    {
      title: 'Find webhook sources',
      description:
        "The workspace's inbound webhook sources (Sentry, Vercel, GitHub), oldest first: whether each accepts deliveries, when it last received one and, in detail, what became of the latest. Never returns a signing secret. For each delivery's fate, use `mocco_notifications_activity_search` with `sourceId`. Read-only.",
      inputSchema: sourcesInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await searchInboundSources(deps, args, userIdOf(ctx))),
  );
}
