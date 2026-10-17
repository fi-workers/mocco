// `mocco_messenger_*` for a project's messenger setup: its settings (the categories a contact
// picks from, whether people who aren't signed in may write) and its round-robin rotation
// (who takes new conversations, and who is available).
//
// Thin adapters (ADR 0025) over the services the console's `messenger` router calls for the
// same answers and changes: `MessengerSettingsService` (`get`, `setCategories`,
// `setAllowGuests`) and `InboxService` (`members`, `addMember`, `removeMember`,
// `setAvailable`). Each goes through `ProjectScope` with `Products.messenger` and the caller's
// own id; any member may make these changes, as in the console.
//
// The identity secret never comes near a tool: the settings read is the service's projection
// without it, and setting the messenger up or rotating the secret (both of which hand the
// secret out once) stay in the console. The changes have the locks of every changing tool
// (`openDecision`, `confirmThenApply`): `messenger:write`, the workspace's opt-in, and a
// confirmation bound to what it showed, so a change in between asks again.
import { isDeepStrictEqual } from 'node:util';

import { messengerCategoriesSchema } from '@mocco/common/messenger';
import { z } from 'zod';

import { confirmThenApply, openDecision, refused } from '@backend/transport/mcp/tools/deciding';
import {
  assigneeOf,
  AssigneeWords,
  MESSENGER_WRITE,
  messengerRefusal,
  projectArg,
  requireMessengerWrite,
  resolveMessengerProject,
} from '@backend/transport/mcp/tools/messenger';
import { asJson, userIdOf, workspaceArg } from '@backend/transport/mcp/tools/runs';

import type { InboxService } from '@backend/domain/messenger/InboxService';
import type { MessengerSettingsService } from '@backend/domain/messenger/MessengerSettingsService';
import type { DecisionWords } from '@backend/transport/mcp/tools/deciding';
import type { MessengerToolDeps } from '@backend/transport/mcp/tools/messenger';
import type { MessengerCategory } from '@mocco/common/messenger';
import type { CallToolResult, InputRequiredResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

export interface MessengerSetupToolDeps extends Omit<MessengerToolDeps, 'messengerInbox'> {
  messengerSettings: Pick<MessengerSettingsService, 'get' | 'setCategories' | 'setAllowGuests'>;
  messengerInbox: Pick<InboxService, 'members' | 'addMember' | 'removeMember' | 'setAvailable' | 'assignable'>;
}

export const MESSENGER_CATEGORIES_TOOL = 'mocco_messenger_categories_set';
export const MESSENGER_GUESTS_TOOL = 'mocco_messenger_guest_access_set';
export const MESSENGER_MEMBERS_ADD_TOOL = 'mocco_messenger_inbox_members_add';
export const MESSENGER_MEMBERS_REMOVE_TOOL = 'mocco_messenger_inbox_members_remove';
export const MESSENGER_AVAILABILITY_TOOL = 'mocco_messenger_inbox_members_set_availability';

const personArg = (what: string) =>
  z
    .union([z.literal(AssigneeWords.me), z.uuid()])
    .describe(`${what}: \`me\`, or a workspace member's user id (as \`mocco_messenger_inbox_members_list\` gives it).`);

const projectInput = z.object({ workspaceId: workspaceArg, projectId: projectArg });

const categoriesInput = projectInput.extend({
  categories: messengerCategoriesSchema.describe(
    'Every category, in the order a contact sees them: the new list replaces the old one. Each has a `key` the app sends and a `label` people read.',
  ),
});

const guestsInput = projectInput.extend({
  allowGuests: z
    .boolean()
    .describe("`true` lets people who aren't signed in write, leaving an email; `false` takes only signed-in users."),
});

const memberInput = projectInput.extend({ userId: personArg('Who') });

const availabilityInput = projectInput.extend({
  userId: personArg('Whose availability').default(AssigneeWords.me),
  available: z.boolean().describe('`true`: round robin gives them new conversations; `false` (away): it skips them.'),
});

export type CategoriesArgs = z.infer<typeof categoriesInput>;
export type GuestsArgs = z.infer<typeof guestsInput>;
export type MemberArgs = z.infer<typeof memberInput>;
export type AvailabilityArgs = z.infer<typeof availabilityInput>;

/** A refusal for a project whose messenger was never set up, pointing at the console. */
const NOT_SET_UP =
  "The messenger isn't set up for this project. Set it up from the project's Inbox in the Mocco console: it shows the identity secret once, so it stays with a person.";

/** The settings, without the identity secret; `isSetUp: false` while the messenger is off. */
export async function getSettings(deps: MessengerSetupToolDeps, args: z.infer<typeof projectInput>, userId: string) {
  const scope = await resolveMessengerProject(deps, userId, args);
  const settings = await deps.messengerSettings.get(scope.workspaceId, scope.projectId);
  return settings === undefined
    ? { ...scope, isSetUp: false }
    : {
        ...scope,
        isSetUp: true,
        categories: settings.categories,
        allowGuests: settings.allowGuests,
        updatedAt: settings.updatedAt,
      };
}

/** Who takes new conversations, in round-robin order of joining, and whether each is available. */
export async function listMembers(deps: MessengerSetupToolDeps, args: z.infer<typeof projectInput>, userId: string) {
  const scope = await resolveMessengerProject(deps, userId, args);
  const members = await deps.messengerInbox.members(scope.workspaceId, scope.projectId);
  return { ...scope, members };
}

const listOf = (categories: MessengerCategory[]) =>
  categories.length === 0 ? '  (none)' : categories.map(category => `  ${category.key}: ${category.label}`).join('\n');

const words = (verb: string, doing: string): DecisionWords => ({
  verb,
  doing,
  scope: MESSENGER_WRITE,
  instead: "change it in the project's Inbox settings in the Mocco console",
});

const categoriesWords = words('change messenger categories', 'Changing the categories');
const guestsWords = words('change messenger guest access', 'Changing guest access');
const rotationWords = words('change the messenger rotation', 'Changing the rotation');

/** Replace the categories a contact picks from, as the caller, once they confirm both lists. */
export async function setCategories(
  deps: MessengerSetupToolDeps,
  args: CategoriesArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openDecision(deps, ctx, args.workspaceId, categoriesWords);
    if ('content' in opened) {
      return opened;
    }
    const { userId, workspaceId, confirmations } = opened;
    const scope = await resolveMessengerProject(deps, userId, { workspaceId, projectId: args.projectId });
    const settings = await deps.messengerSettings.get(scope.workspaceId, scope.projectId);
    if (settings === undefined) {
      return refused(NOT_SET_UP);
    }
    const from = settings.categories.map(({ key, label }) => ({ key, label }));
    const to = args.categories.map(({ key, label }) => ({ key, label }));
    if (isDeepStrictEqual(from, to)) {
      return asJson({ changed: false, categories: from, reason: 'They are these already.' });
    }
    const kept = new Set(to.map(category => category.key));
    const removed = from.filter(category => !kept.has(category.key)).map(category => category.key);
    const question = [
      'Change the categories contacts pick from, as you?',
      `Now:\n${listOf(from)}`,
      `After:\n${listOf(to)}`,
      ...(removed.length > 0
        ? [`An app that still sends ${removed.join(', ')} is refused when it starts a conversation with it.`]
        : []),
    ].join('\n');
    // Bound to the list it was asked from: anyone else's edit in between asks again.
    const change = { tool: MESSENGER_CATEGORIES_TOOL, ...scope, from, to };
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Change the categories',
      ask: async () => await Promise.resolve(question),
      apply: async () =>
        asJson({
          changed: true,
          ...(await deps.messengerSettings.setCategories(scope.workspaceId, scope.projectId, userId, to)),
        }),
    });
  } catch (error) {
    return messengerRefusal(error);
  }
}

/** Let people who aren't signed in write, or stop them, as the caller, once they confirm. */
export async function setGuestAccess(
  deps: MessengerSetupToolDeps,
  args: GuestsArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openDecision(deps, ctx, args.workspaceId, guestsWords);
    if ('content' in opened) {
      return opened;
    }
    const { userId, workspaceId, confirmations } = opened;
    const scope = await resolveMessengerProject(deps, userId, { workspaceId, projectId: args.projectId });
    const settings = await deps.messengerSettings.get(scope.workspaceId, scope.projectId);
    if (settings === undefined) {
      return refused(NOT_SET_UP);
    }
    if (settings.allowGuests === args.allowGuests) {
      return asJson({
        changed: false,
        allowGuests: settings.allowGuests,
        reason: settings.allowGuests ? 'Guests may write already.' : 'Guests may not write already.',
      });
    }
    const question = args.allowGuests
      ? [
          "Let people who aren't signed in write to your team, as you?",
          'They leave an email instead of a signed user id; their sessions need no signature from your server, so they are limited per IP address.',
        ]
      : [
          'Take messages only from signed-in users, as you?',
          'New guest sessions are refused; the conversations guests already started stay in the inbox.',
        ];
    const change = { tool: MESSENGER_GUESTS_TOOL, ...scope, from: settings.allowGuests, to: args.allowGuests };
    return await confirmThenApply(ctx, confirmations, change, {
      label: args.allowGuests ? 'Let guests write' : 'Signed-in users only',
      ask: async () => await Promise.resolve(question.join('\n')),
      apply: async () =>
        asJson({
          changed: true,
          ...(await deps.messengerSettings.setAllowGuests(
            scope.workspaceId,
            scope.projectId,
            userId,
            args.allowGuests,
          )),
        }),
    });
  } catch (error) {
    return messengerRefusal(error);
  }
}

/** The project's rotation, and the person a change names in it. */
async function rotationFor(
  deps: MessengerSetupToolDeps,
  scope: { workspaceId: string; projectId: string },
  who: string,
) {
  const members = await deps.messengerInbox.members(scope.workspaceId, scope.projectId);
  return { members, member: members.find(member => member.userId === who) };
}

const inRotation = (person: { name: string | null; email: string }) =>
  person.name === null ? person.email : `${person.name} (${person.email})`;

/** Put a workspace member in the rotation (available), as the caller, once they confirm. */
export async function addMember(
  deps: MessengerSetupToolDeps,
  args: MemberArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openDecision(deps, ctx, args.workspaceId, rotationWords);
    if ('content' in opened) {
      return opened;
    }
    const { userId, workspaceId, confirmations } = opened;
    const scope = await resolveMessengerProject(deps, userId, { workspaceId, projectId: args.projectId });
    const who = assigneeOf(args.userId, userId) ?? userId;
    // Someone outside the workspace is refused before anything is asked.
    const person = await deps.messengerInbox.assignable(scope.workspaceId, who);
    const { members, member } = await rotationFor(deps, scope, who);
    if (member !== undefined) {
      return asJson({ changed: false, userId: who, reason: 'They are in the rotation already.' });
    }
    const question = [
      `Add ${inRotation(person)} to this inbox's rotation, as you?`,
      `They join available, so the next new conversation is theirs (${members.length} in the rotation now).`,
    ].join('\n');
    const change = { tool: MESSENGER_MEMBERS_ADD_TOOL, ...scope, userId: who };
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Add to the rotation',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        await deps.messengerInbox.addMember(scope.workspaceId, scope.projectId, userId, who);
        return asJson({ changed: true, userId: who, available: true });
      },
    });
  } catch (error) {
    return messengerRefusal(error);
  }
}

/** Take someone out of the rotation, as the caller, once they confirm. */
export async function removeMember(
  deps: MessengerSetupToolDeps,
  args: MemberArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openDecision(deps, ctx, args.workspaceId, rotationWords);
    if ('content' in opened) {
      return opened;
    }
    const { userId, workspaceId, confirmations } = opened;
    const scope = await resolveMessengerProject(deps, userId, { workspaceId, projectId: args.projectId });
    const who = assigneeOf(args.userId, userId) ?? userId;
    const { member } = await rotationFor(deps, scope, who);
    if (member === undefined) {
      return asJson({ changed: false, userId: who, reason: 'They are not in the rotation.' });
    }
    const question = [
      `Take ${inRotation(member)} out of this inbox's rotation, as you?`,
      'New conversations stop coming to them; the ones they have stay theirs.',
    ].join('\n');
    const change = { tool: MESSENGER_MEMBERS_REMOVE_TOOL, ...scope, userId: who };
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Take out of the rotation',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        await deps.messengerInbox.removeMember(scope.workspaceId, scope.projectId, userId, who);
        return asJson({ changed: true, userId: who });
      },
    });
  } catch (error) {
    return messengerRefusal(error);
  }
}

/** Mark someone in the rotation available or away, once the caller confirms. */
export async function setAvailability(
  deps: MessengerSetupToolDeps,
  args: AvailabilityArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openDecision(deps, ctx, args.workspaceId, rotationWords);
    if ('content' in opened) {
      return opened;
    }
    const { userId, workspaceId, confirmations } = opened;
    const scope = await resolveMessengerProject(deps, userId, { workspaceId, projectId: args.projectId });
    const who = assigneeOf(args.userId, userId) ?? userId;
    const { member } = await rotationFor(deps, scope, who);
    if (member === undefined) {
      const subject = who === userId ? 'You are' : `${who} is`;
      return refused(`${subject} not in this inbox's rotation. Add them with \`${MESSENGER_MEMBERS_ADD_TOOL}\` first.`);
    }
    if (member.available === args.available) {
      return asJson({
        changed: false,
        userId: who,
        available: member.available,
        reason: member.available ? 'They are available already.' : 'They are away already.',
      });
    }
    const person = who === userId ? 'yourself' : inRotation(member);
    const question = args.available
      ? [`Mark ${person} available, as you?`, 'Round robin gives them new conversations again, starting with the next.']
      : [`Mark ${person} away, as you?`, 'Round robin skips them; the conversations they have stay theirs.'];
    // Bound to their availability when asked.
    const change = {
      tool: MESSENGER_AVAILABILITY_TOOL,
      ...scope,
      userId: who,
      from: member.available,
      to: args.available,
    };
    return await confirmThenApply(ctx, confirmations, change, {
      label: args.available ? 'Mark available' : 'Mark away',
      ask: async () => await Promise.resolve(question.join('\n')),
      apply: async () =>
        asJson({
          changed: true,
          userId: who,
          ...(await deps.messengerInbox.setAvailable(scope.workspaceId, scope.projectId, {
            userId: who,
            available: args.available,
          })),
        }),
    });
  } catch (error) {
    return messengerRefusal(error);
  }
}

export function registerMessengerSetupTools(server: McpServer, deps: MessengerSetupToolDeps): void {
  server.registerTool(
    'mocco_messenger_settings_get',
    {
      title: "Read a project's messenger settings",
      description:
        "Whether the project's messenger is set up and, if so, the categories a contact picks from (in order) and whether people who aren't signed in may write. Never the identity secret. Read-only.",
      inputSchema: projectInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await getSettings(deps, args, userIdOf(ctx))),
  );

  server.registerTool(
    'mocco_messenger_inbox_members_list',
    {
      title: "List a messenger inbox's rotation",
      description:
        'Who takes new conversations in the project (round robin), in the order they joined: user id, name, email, whether they are available or away, and when they were last given one. Read-only.',
      inputSchema: projectInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await listMembers(deps, args, userIdOf(ctx))),
  );

  server.registerTool(
    MESSENGER_CATEGORIES_TOOL,
    {
      title: 'Change the messenger categories',
      description:
        'Replace the categories a contact picks from when they start a conversation (up to 12, unique keys), as the signed-in person; recorded in the audit log. The person is shown both lists and asked to confirm in their client first, and it only works where the workspace allows agents to make changes.',
      inputSchema: categoriesInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      scopeChallenge: requireMessengerWrite('Changing the categories'),
    },
    async (args, ctx) => await setCategories(deps, args, ctx),
  );

  server.registerTool(
    MESSENGER_GUESTS_TOOL,
    {
      title: 'Turn messenger guest access on or off',
      description:
        "Let people who aren't signed in write to the team, leaving an email (`allowGuests: true`), or take only signed-in users (`false`), as the signed-in person; recorded in the audit log. The person is asked to confirm in their client first, and it only works where the workspace allows agents to make changes.",
      inputSchema: guestsInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      scopeChallenge: requireMessengerWrite('Changing guest access'),
    },
    async (args, ctx) => await setGuestAccess(deps, args, ctx),
  );

  server.registerTool(
    MESSENGER_MEMBERS_ADD_TOOL,
    {
      title: 'Add someone to a messenger rotation',
      description:
        "Put a workspace member (`me` or their user id) in the project's round-robin rotation, available, as the signed-in person; recorded in the audit log. The person is asked to confirm in their client first, and it only works where the workspace allows agents to make changes.",
      inputSchema: memberInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      scopeChallenge: requireMessengerWrite('Changing the rotation'),
    },
    async (args, ctx) => await addMember(deps, args, ctx),
  );

  server.registerTool(
    MESSENGER_MEMBERS_REMOVE_TOOL,
    {
      title: 'Take someone out of a messenger rotation',
      description:
        "Take someone out of the project's round-robin rotation, as the signed-in person; the conversations they have stay theirs; recorded in the audit log. The person is asked to confirm in their client first, and it only works where the workspace allows agents to make changes.",
      inputSchema: memberInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      scopeChallenge: requireMessengerWrite('Changing the rotation'),
    },
    async (args, ctx) => await removeMember(deps, args, ctx),
  );

  server.registerTool(
    MESSENGER_AVAILABILITY_TOOL,
    {
      title: 'Mark someone available or away in a messenger rotation',
      description:
        'Mark someone in the rotation (`me` by default, or their user id) available, so round robin gives them new conversations, or away, so it skips them. As in the console, availability is not recorded in the audit log. The person is asked to confirm in their client first, and it only works where the workspace allows agents to make changes.',
      inputSchema: availabilityInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      scopeChallenge: requireMessengerWrite('Changing the rotation'),
    },
    async (args, ctx) => await setAvailability(deps, args, ctx),
  );
}
