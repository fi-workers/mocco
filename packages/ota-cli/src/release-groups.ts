// How many releases one `mocco-ota publish` becomes. A release carries one runtime
// version, so the platforms that share one are published together.
import type { OtaPlatform } from '@mocco/common/ota-hosting';

export interface ReleaseGroup {
  runtimeVersion: string;
  platforms: OtaPlatform[];
}

/**
 * Group `platforms` by the runtime version `resolve` gives each one, keeping the order
 * they were asked for. A literal, the `appVersion` policy and `--runtime-version` return
 * the same value for every platform, so they stay one release; the `fingerprint` policy
 * hashes iOS and Android differently (different native dependencies and config), so they
 * become separate releases. Publishing those under a single runtime version would leave
 * one platform's devices never matching an update.
 *
 * `resolve` is called once per platform, sequentially: computing a fingerprint walks the
 * whole project, so two at once only thrash.
 */
export async function releaseGroupsOf(
  platforms: readonly OtaPlatform[],
  resolve: (platform: OtaPlatform) => Promise<string>,
): Promise<ReleaseGroup[]> {
  const groups = await platforms.reduce(async (previous, platform) => {
    const sofar = await previous;
    const runtimeVersion = await resolve(platform);
    return sofar.set(runtimeVersion, [...(sofar.get(runtimeVersion) ?? []), platform]);
  }, Promise.resolve(new Map<string, OtaPlatform[]>()));
  return [...groups].map(([runtimeVersion, group]) => ({ runtimeVersion, platforms: group }));
}
