// The agent's settings, from the environment. The only place that reads it.
import { ProbeProtocol } from '@mocco/common/status';
import { z } from 'zod';

const flag = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform(value => value === 'true' || value === '1');

export const probeConfigSchema = z.object({
  /** Mocco's origin, e.g. `https://www.mocco.work`. */
  MOCCO_URL: z.url({ protocol: /^https?$/ }),
  /** The location's token (`mpl_…`), shown once when the location was created or its token rotated. */
  MOCCO_PROBE_TOKEN: z.string().trim().startsWith('mpl_'),
  /** How many checks run at once. */
  MOCCO_PROBE_CONCURRENCY: z.coerce.number().int().min(1).max(ProbeProtocol.maxCapacity).default(20),
  /** Set on Mocco's hosted fleet: refuse targets that resolve to private, loopback, link-local or metadata addresses. */
  MOCCO_PROBE_HOSTED: flag,
});

export type ProbeConfig = z.infer<typeof probeConfigSchema>;

/** The parsed settings, or the list of what's wrong with them. */
export function readConfig(env: Record<string, string | undefined>): {
  config: ProbeConfig | undefined;
  problems: string[] | undefined;
} {
  const parsed = probeConfigSchema.safeParse(env);
  return parsed.success
    ? { config: parsed.data, problems: undefined }
    : { config: undefined, problems: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`) };
}
