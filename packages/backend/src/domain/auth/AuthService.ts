// Session/auth service — cohesive business-logic unit, one file per service.
// Constructor injection: the provider (the vendor handle, our "repo layer")
// flows in as a value, so tests bind pglite through the same constructor
// production uses. Explicit return types pin the neutral shapes from
// @mocco/common so vendor type inference cannot leak.
import { toNodeAuthHandler, type NodeAuthHandler, type Provider } from '@backend/domain/auth/provider';

import type { Session } from '@mocco/common/auth';

export class AuthService {
  /** Node-style (req, res) handler for Pages Router API routes. */
  readonly nodeHandler: NodeAuthHandler;

  constructor(private readonly provider: Provider) {
    this.nodeHandler = toNodeAuthHandler(provider);
  }

  /** Fetch-standard handler (Request → Response) for the auth routes. */
  async handler(request: Request): Promise<Response> {
    return await this.provider.handler(request);
  }

  /** Read the current session from request headers (cookie-based). */
  async getSession(headers: Headers): Promise<Session | null> {
    return await this.provider.api.getSession({ headers });
  }
}
