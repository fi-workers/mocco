// /v1/messenger (#95): the app's users talk to its team. `POST /sessions` takes a key
// with `messenger:chat` plus the user's id signed by the app's server, and returns a
// session token (`mms_…`); every other route takes that token as `Authorization: Bearer`
// and only ever sees that user's conversations. Internal notes are never served here.
import { ApiScopes } from '@mocco/common/apikey';
import {
  conversationCreateInputSchema,
  markReadInputSchema,
  messageCreateInputSchema,
  messengerSessionInputSchema,
} from '@mocco/common/messenger';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';

import {
  ContactBlockedError,
  ConversationNotFoundError,
  IdentityVerificationError,
  MessengerNotEnabledError,
  UnknownCategoryError,
} from '@backend/domain/messenger/errors';
import { isSessionToken } from '@backend/domain/messenger/identity';
import { limit, requireKey } from '@backend/transport/ext/v1/middleware';
import { parseJson, problemOf, problemResponse, ProblemCodes } from '@backend/transport/ext/v1/problem';

import type { ContactMessengerService, ContactPrincipal } from '@backend/domain/messenger/ContactMessengerService';
import type { V1Deps, V1Env } from '@backend/transport/ext/v1/middleware';

export interface MessengerServingDeps {
  contacts: Pick<
    ContactMessengerService,
    'createSession' | 'authenticate' | 'listConversations' | 'startConversation' | 'messages' | 'send' | 'markRead'
  >;
}

/** Per-contact limits on top of the key's own. */
export const MessengerRateLimits = {
  sessions: { limit: 300, windowSeconds: 60 },
  messages: { limit: 20, windowSeconds: 60 },
  conversations: { limit: 5, windowSeconds: 60 * 60 },
} as const;

interface MessengerEnv {
  Variables: V1Env['Variables'] & { contact: ContactPrincipal };
}

const BEARER = 'Bearer ';

/** The domain errors a contact can cause, as problem responses. */
function problemFor(error: unknown): Response {
  if (error instanceof IdentityVerificationError) {
    return problemResponse(
      problemOf(401, ProblemCodes.identityNotVerified, 'The user hash does not match the user id'),
    );
  }
  if (error instanceof ContactBlockedError) {
    return problemResponse(
      problemOf(403, ProblemCodes.contactBlocked, 'This user is blocked from contacting the team'),
    );
  }
  if (error instanceof ConversationNotFoundError || error instanceof MessengerNotEnabledError) {
    return problemResponse(problemOf(404, ProblemCodes.notFound, 'Not found', error.message));
  }
  if (error instanceof UnknownCategoryError) {
    return problemResponse(problemOf(400, ProblemCodes.badRequest, 'Invalid request', error.message));
  }
  throw error;
}

const answer = async (work: () => Promise<Response>): Promise<Response> => {
  try {
    return await work();
  } catch (error) {
    return problemFor(error);
  }
};

export function createMessengerRoutes(deps: V1Deps, messenger: MessengerServingDeps): Hono<V1Env> {
  const app = new Hono<V1Env>();

  app.post(
    '/sessions',
    requireKey(deps, {
      scope: ApiScopes.messengerChat,
      routeLimit: {
        name: 'messenger-sessions',
        rules: { publishable: MessengerRateLimits.sessions, secret: MessengerRateLimits.sessions },
      },
    }),
    async c => {
      const body = await parseJson(c, messengerSessionInputSchema);
      if (body.refused !== undefined) {
        return body.refused;
      }
      const { workspaceId, projectId } = c.var.principal;
      return await answer(async () =>
        c.json(await messenger.contacts.createSession({ workspaceId, projectId }, body.data), 201),
      );
    },
  );

  const session = new Hono<MessengerEnv>();
  session.use(
    '*',
    createMiddleware<MessengerEnv>(async (c, next) => {
      const header = c.req.header('authorization') ?? '';

      const token = header.startsWith(BEARER) ? header.slice(BEARER.length).trim() : '';
      const principal = isSessionToken(token) ? await messenger.contacts.authenticate(token) : undefined;
      if (principal === undefined) {
        return problemResponse(
          problemOf(401, ProblemCodes.invalidSession, 'The messenger session is missing or expired'),
          {
            'WWW-Authenticate': 'Bearer',
          },
        );
      }
      c.set('contact', principal);
      await next();
      return undefined;
    }),
  );

  session.get('/conversations', async c =>
    c.json({ conversations: await messenger.contacts.listConversations(c.var.contact) }),
  );

  session.post('/conversations', async c => {
    const contactId = c.var.contact.contact.id;
    const limited = await limit(deps, `messenger:conversations:${contactId}`, MessengerRateLimits.conversations);
    if (limited.refused !== undefined) {
      return limited.refused;
    }
    const body = await parseJson(c, conversationCreateInputSchema);
    if (body.refused !== undefined) {
      return body.refused;
    }
    return await answer(async () =>
      c.json({ conversation: await messenger.contacts.startConversation(c.var.contact, body.data) }, 201),
    );
  });

  session.get('/conversations/:id/messages', async c => {
    const afterSeq = z.coerce.number().int().min(0).catch(0).parse(c.req.query('afterSeq'));
    return await answer(async () =>
      c.json({ messages: await messenger.contacts.messages(c.var.contact, c.req.param('id'), afterSeq) }),
    );
  });

  session.post('/conversations/:id/messages', async c => {
    const contactId = c.var.contact.contact.id;
    const limited = await limit(deps, `messenger:messages:${contactId}`, MessengerRateLimits.messages);
    if (limited.refused !== undefined) {
      return limited.refused;
    }
    const body = await parseJson(c, messageCreateInputSchema);
    if (body.refused !== undefined) {
      return body.refused;
    }
    return await answer(async () =>
      c.json({ message: await messenger.contacts.send(c.var.contact, c.req.param('id'), body.data) }, 201),
    );
  });

  session.post('/conversations/:id/read', async c => {
    const body = await parseJson(c, markReadInputSchema);
    if (body.refused !== undefined) {
      return body.refused;
    }
    return await answer(async () => {
      await messenger.contacts.markRead(c.var.contact, c.req.param('id'), body.data.seq);
      return c.body(null, 204);
    });
  });

  app.route('/', session);
  return app;
}
