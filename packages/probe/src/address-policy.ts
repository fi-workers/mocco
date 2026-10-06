// Which addresses a probe may connect to (ADR 0027 §7). A hosted location refuses everything
// that isn't on the public internet (the shared list in @mocco/common/address-policy); a private
// location skips the list, since reaching private targets is what it is for.
import { isPublicAddress } from '@mocco/common/address-policy';

import type { AddressPolicy } from '@mocco/common/address-policy';

/** A hosted location refuses everything but public addresses; a private location allows all. */
export const addressPolicyFor = (isHosted: boolean): AddressPolicy => (isHosted ? isPublicAddress : () => true);
