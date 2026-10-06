// Production composition root for end-user tokens. The project's identity secret is the one
// the messenger setup mints, so the messenger settings are where it is read from.
import { EndUserTokenService } from '@backend/domain/enduser/EndUserTokenService';
import { getMessengerDomain } from '@backend/domain/messenger/instance';

const state: { tokens?: EndUserTokenService } = {};

export function getEndUserTokens(): EndUserTokenService {
  state.tokens ??= new EndUserTokenService({ secrets: getMessengerDomain().messengerSettings });
  return state.tokens;
}
