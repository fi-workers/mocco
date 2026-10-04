// Runs one monitor spec by its kind. Never throws: whatever goes wrong is a failed report.
import { MonitorKinds, type MonitorSpec } from '@mocco/common/status';

import { failedReport, type CheckContext, type CheckReport } from './check-report';
import { runHttpCheck } from './http-check';
import { runTcpCheck } from './tcp-check';

export type RunCheck = (spec: MonitorSpec) => Promise<CheckReport>;

export const createRunCheck =
  (context: CheckContext): RunCheck =>
  async spec => {
    try {
      switch (spec.kind) {
        case MonitorKinds.http: {
          return await runHttpCheck(spec, context);
        }
        case MonitorKinds.tcp: {
          return await runTcpCheck(spec, context);
        }
        default: {
          const unknown: never = spec;
          throw new Error(`Unknown monitor kind: ${JSON.stringify(unknown)}`);
        }
      }
    } catch (error) {
      return failedReport(error);
    }
  };
