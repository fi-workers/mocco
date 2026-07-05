// Session/auth service — cohesive business-logic unit, one file per service.
// Constructor injection: the provider (the vendor handle, our "repo layer")
// flows in as a value, so tests bind pglite through the same constructor
// production uses. Explicit return types pin the neutral shapes from
// @mocco/common so vendor type inference cannot leak.
import type { Provider } from './provider';
import type { Session } from '@mocco/common/auth';

export class AuthService {
  constructor(private readonly provider: Provider) {}

  /** Fetch-standard handler (Request → Response) for the auth routes. */
  async handler(request: Request): Promise<Response> {
    return await this.provider.handler(request);
  }

  /** Read the current session from request headers (cookie-based). */
  async getSession(headers: Headers): Promise<Session | null> {
    return await this.provider.api.getSession({ headers });
  }
}
