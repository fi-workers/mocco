import { z } from 'zod';

/**
 * Audit-log shapes (slice 8, PR1). The audit is an append-only, per-workspace hash
 * chain — a system property, always on (ADR 0010), not a `.mocco.yml` toggle. Every
 * governance decision appends an entry whose `hash = sha-256(prev_hash ?? '' ||
 * canonical(semantic fields))`; any observer can re-walk the chain and prove it
 * hasn't been altered. Defined once as zod schemas (the single type source) and used
 * as the tRPC `.output()` egress filter (the read surface lands in PR2).
 */

/** The governance actions an audit entry records — the SSOT for `action` (no magic
 * strings). Values are dotted `domain.event` strings, an extensible set: a new
 * governed event adds a key here. `gate.*` from GateService, `credential.*` from the
 * broker, `run.triggered` from RunService — all wired in PR2. */
export const AuditActions = {
  gateResumed: 'gate.resumed',
  gateRejected: 'gate.rejected',
  credentialIssued: 'credential.issued',
  credentialDenied: 'credential.denied',
  runTriggered: 'run.triggered',
  approvalRequested: 'approval.requested',
  approvalApproved: 'approval.approved',
  approvalRejected: 'approval.rejected',
  approvalSuperseded: 'approval.superseded',
  approvalExpired: 'approval.expired',
  versionPolicyChanged: 'ota.version_policy.changed',
  versionPolicyApprovalStale: 'ota.version_policy.approval_stale',
  otaCredentialCreated: 'ota.credential.created',
  otaCredentialRotated: 'ota.credential.rotated',
  otaCredentialDeleted: 'ota.credential.deleted',
  otaAppCreated: 'ota.app.created',
  otaCertAdded: 'ota.cert.added',
  otaCertRetired: 'ota.cert.retired',
  otaChannelCreated: 'ota.channel.created',
  otaChannelPolicyChanged: 'ota.channel.policy_changed',
  otaChannelPolicyApprovalStale: 'ota.channel.policy_approval_stale',
  otaUploadAuthorized: 'ota.upload.authorized',
  otaUploadDenied: 'ota.upload.denied',
  otaTrustPolicyCreated: 'ota.trust_policy.created',
  otaTrustPolicyDeleted: 'ota.trust_policy.deleted',
  otaReleaseUploaded: 'ota.release.uploaded',
  otaReleaseFailed: 'ota.release.failed',
  otaChannelChanged: 'ota.channel.changed',
  otaChannelChangeFailed: 'ota.channel.change_failed',
  flagEnvironmentCreated: 'flag.environment.created',
  flagCreated: 'flag.created',
  /** A flag's description, lifecycle, variants or owner changed by a `.mocco/flags.yml` sync (#145). */
  flagDefinitionChanged: 'flag.definition.changed',
  /** A `.mocco/flags.yml` sync ran on a commit (#145). */
  flagFileSynced: 'flag.file.synced',
  flagChangesetApplied: 'flag.changeset.applied',
  flagChangesetProposed: 'flag.changeset.proposed',
  flagChangesetRejected: 'flag.changeset.rejected',
  flagChangesetConflicted: 'flag.changeset.conflicted',
  flagChangesetWithdrawn: 'flag.changeset.withdrawn',
  /** A newer push of `.mocco/flags.yml` replaced a pending repo changeset (#145). */
  flagChangesetSuperseded: 'flag.changeset.superseded',
  flagChangesetExpired: 'flag.changeset.expired',
  flagChangeGateChanged: 'flag.change_gate.changed',
  flagKilled: 'flag.killed',
  flagRestored: 'flag.restored',
  flagKillRolesChanged: 'flag.kill_roles.changed',
  /** An environment's linked pipeline (the repo its timeline shows runs of) changed (#146). */
  flagLinkedPipelineChanged: 'flag.linked_pipeline.changed',
  flagClientVisibilityChanged: 'flag.client_visible.changed',
  flagStaleDismissed: 'flag.stale.dismissed',
  messengerEnabled: 'messenger.enabled',
  messengerSecretRotated: 'messenger.secret.rotated',
  messengerCategoriesChanged: 'messenger.categories.changed',
  messengerContactBlocked: 'messenger.contact.blocked',
  messengerContactErased: 'messenger.contact.erased',
  helpSiteEnabled: 'help.site.enabled',
  helpSiteChanged: 'help.site.changed',
  /** Whether the site's robots.txt lets AI training crawlers in (#363). */
  helpSiteAiTrainingChanged: 'help.site.ai_training.changed',
  helpArticlePublished: 'help.article.published',
  helpArticleUnpublished: 'help.article.unpublished',
  helpArticleDeleted: 'help.article.deleted',
  messengerGuestsChanged: 'messenger.guests.changed',
  apiKeyCreated: 'apikey.created',
  apiKeyRevoked: 'apikey.revoked',
  /** A workspace turned the MCP deciding tools on or off. */
  mcpAgentsMayDecideChanged: 'mcp.agents_may_decide.changed',
  statusPageCreated: 'status.page.created',
  statusPageDeleted: 'status.page.deleted',
  /** An operator set a component's status by hand. */
  statusComponentStatusChanged: 'status.component.status_changed',
  statusIncidentCreated: 'status.incident.created',
  /** An update was posted to an incident's timeline; the payload carries the status change. */
  statusIncidentUpdated: 'status.incident.updated',
  statusIncidentComponentsChanged: 'status.incident.components_changed',
  statusIncidentPostmortemChanged: 'status.incident.postmortem_changed',
  statusMaintenanceScheduled: 'status.maintenance.scheduled',
  statusMaintenanceCanceled: 'status.maintenance.canceled',
  /** The maintenance tick started a window (no actor). */
  statusMaintenanceStarted: 'status.maintenance.started',
  /** The maintenance tick completed a window (no actor). */
  statusMaintenanceCompleted: 'status.maintenance.completed',
  statusMonitorCreated: 'status.monitor.created',
  statusMonitorUpdated: 'status.monitor.updated',
  statusMonitorDeleted: 'status.monitor.deleted',
  statusMonitorPaused: 'status.monitor.paused',
  statusMonitorResumed: 'status.monitor.resumed',
  /** A private probe location was created; its token is shown once. */
  statusLocationCreated: 'status.location.created',
  statusLocationTokenRotated: 'status.location.token_rotated',
  statusLocationDisabled: 'status.location.disabled',
  /** A Discord channel was connected as a notification channel; the test message's result is in the payload. */
  notificationChannelConnected: 'notification.channel.connected',
  notificationChannelDeleted: 'notification.channel.deleted',
  notificationChannelReenabled: 'notification.channel.reenabled',
  notificationRuleAdded: 'notification.rule.added',
  notificationRuleRemoved: 'notification.rule.removed',
  /** A preset's rules were added to a channel (only when it added any). */
  notificationPresetApplied: 'notification.preset.applied',
} as const;
export type AuditAction = (typeof AuditActions)[keyof typeof AuditActions];
export const auditActionSchema = z.enum(Object.values(AuditActions) as [AuditAction, ...AuditAction[]]);

/**
 * What each action means, in words — what people see on Home and the Audit page. A
 * Record over every action and kept next to `AuditActions`, so adding an action
 * without its label fails the type check in the same file.
 */
export const auditActionLabels: Readonly<Record<AuditAction, string>> = {
  [AuditActions.gateResumed]: 'Deploy gate approved',
  [AuditActions.gateRejected]: 'Deploy gate rejected',
  [AuditActions.credentialIssued]: 'Credential released to a pipeline',
  [AuditActions.credentialDenied]: 'Credential refused to a pipeline',
  [AuditActions.runTriggered]: 'Pipeline run started',
  [AuditActions.approvalRequested]: 'Approval requested',
  [AuditActions.approvalApproved]: 'Approval granted',
  [AuditActions.approvalRejected]: 'Approval rejected',
  [AuditActions.approvalSuperseded]: 'Approval request replaced',
  [AuditActions.approvalExpired]: 'Approval request expired',
  [AuditActions.versionPolicyChanged]: 'App version policy changed',
  [AuditActions.versionPolicyApprovalStale]: 'App version approval went stale',
  [AuditActions.otaCredentialCreated]: 'OTA publishing token added',
  [AuditActions.otaCredentialRotated]: 'OTA publishing token rotated',
  [AuditActions.otaCredentialDeleted]: 'OTA publishing token removed',
  [AuditActions.otaAppCreated]: 'OTA hosting turned on for an app',
  [AuditActions.otaCertAdded]: 'OTA signing certificate added',
  [AuditActions.otaCertRetired]: 'OTA signing certificate retired',
  [AuditActions.otaChannelCreated]: 'OTA channel created',
  [AuditActions.otaChannelPolicyChanged]: 'OTA channel protection changed',
  [AuditActions.otaChannelPolicyApprovalStale]: 'OTA channel approval went stale',
  [AuditActions.otaUploadAuthorized]: 'OTA upload allowed',
  [AuditActions.otaUploadDenied]: 'OTA upload refused',
  [AuditActions.otaTrustPolicyCreated]: 'OTA trusted publisher added',
  [AuditActions.otaTrustPolicyDeleted]: 'OTA trusted publisher removed',
  [AuditActions.otaReleaseUploaded]: 'OTA release uploaded',
  [AuditActions.otaReleaseFailed]: 'OTA release upload failed',
  [AuditActions.otaChannelChanged]: 'OTA channel changed',
  [AuditActions.otaChannelChangeFailed]: 'OTA channel change failed',
  [AuditActions.flagEnvironmentCreated]: 'Flag environment created',
  [AuditActions.flagCreated]: 'Feature flag created',
  [AuditActions.flagDefinitionChanged]: 'Feature flag definition changed',
  [AuditActions.flagFileSynced]: 'Flags file synced from the repository',
  [AuditActions.flagChangesetApplied]: 'Flag change applied',
  [AuditActions.flagChangesetProposed]: 'Flag change proposed',
  [AuditActions.flagChangesetRejected]: 'Flag change rejected',
  [AuditActions.flagChangesetConflicted]: 'Flag change conflicted',
  [AuditActions.flagChangesetWithdrawn]: 'Flag change withdrawn',
  [AuditActions.flagChangesetSuperseded]: 'Flag change replaced by a newer push',
  [AuditActions.flagChangesetExpired]: 'Flag change expired',
  [AuditActions.flagChangeGateChanged]: 'Flag environment protection changed',
  [AuditActions.flagKilled]: 'Kill switch used',
  [AuditActions.flagRestored]: 'Killed flag restored',
  [AuditActions.flagKillRolesChanged]: 'Kill switch roles changed',
  [AuditActions.flagLinkedPipelineChanged]: 'Flag environment pipeline linked',
  [AuditActions.flagClientVisibilityChanged]: 'Flag visibility to apps changed',
  [AuditActions.flagStaleDismissed]: 'Stale flag dismissed',
  [AuditActions.messengerEnabled]: 'Messenger set up',
  [AuditActions.messengerSecretRotated]: 'Messenger identity secret rotated',
  [AuditActions.messengerCategoriesChanged]: 'Messenger categories changed',
  [AuditActions.messengerContactBlocked]: 'Messenger contact blocked',
  [AuditActions.messengerContactErased]: 'Messenger contact erased',
  [AuditActions.helpSiteEnabled]: 'Help center set up',
  [AuditActions.helpSiteChanged]: 'Help center settings changed',
  [AuditActions.helpSiteAiTrainingChanged]: 'Help center AI training crawlers changed',
  [AuditActions.helpArticlePublished]: 'Help article published',
  [AuditActions.helpArticleUnpublished]: 'Help article unpublished',
  [AuditActions.helpArticleDeleted]: 'Help article deleted',
  [AuditActions.messengerGuestsChanged]: 'Messenger guest access changed',
  [AuditActions.apiKeyCreated]: 'API key created',
  [AuditActions.apiKeyRevoked]: 'API key revoked',
  [AuditActions.mcpAgentsMayDecideChanged]: 'Agent decisions turned on or off',
  [AuditActions.statusPageCreated]: 'Status page created',
  [AuditActions.statusPageDeleted]: 'Status page deleted',
  [AuditActions.statusComponentStatusChanged]: 'Component status set by hand',
  [AuditActions.statusIncidentCreated]: 'Incident opened',
  [AuditActions.statusIncidentUpdated]: 'Incident updated',
  [AuditActions.statusIncidentComponentsChanged]: 'Incident components changed',
  [AuditActions.statusIncidentPostmortemChanged]: 'Incident postmortem changed',
  [AuditActions.statusMaintenanceScheduled]: 'Maintenance scheduled',
  [AuditActions.statusMaintenanceCanceled]: 'Maintenance canceled',
  [AuditActions.statusMaintenanceStarted]: 'Maintenance started',
  [AuditActions.statusMaintenanceCompleted]: 'Maintenance completed',
  [AuditActions.statusMonitorCreated]: 'Monitor created',
  [AuditActions.statusMonitorUpdated]: 'Monitor changed',
  [AuditActions.statusMonitorDeleted]: 'Monitor deleted',
  [AuditActions.statusMonitorPaused]: 'Monitor paused',
  [AuditActions.statusMonitorResumed]: 'Monitor resumed',
  [AuditActions.statusLocationCreated]: 'Probe location created',
  [AuditActions.statusLocationTokenRotated]: 'Probe location token rotated',
  [AuditActions.statusLocationDisabled]: 'Probe location disabled',
  [AuditActions.notificationChannelConnected]: 'Notification channel connected',
  [AuditActions.notificationChannelDeleted]: 'Notification channel removed',
  [AuditActions.notificationChannelReenabled]: 'Notification channel turned back on',
  [AuditActions.notificationRuleAdded]: 'Notification rule added',
  [AuditActions.notificationRuleRemoved]: 'Notification rule removed',
  [AuditActions.notificationPresetApplied]: 'Notification rules added from a preset',
};

/**
 * A single audit-log entry — the wire shape the read surface (PR2) renders. `seq` is
 * a DB `bigserial` (the monotonic chain order); it exceeds JS's safe-integer range
 * over time, so it stays a string end-to-end (the same treatment as `commitSchema.seq`
 * / `runEventSchema.seq`). `workspaceId` is egress-stripped like `runEventSchema` (the
 * read is already workspace-scoped). `prevHash` is null for a workspace's first entry.
 */
export const auditEntrySchema = z.object({
  seq: z.string(),
  id: z.uuid(),
  actorUserId: z.uuid().nullable(),
  action: auditActionSchema,
  subjectType: z.string(),
  subjectId: z.string(),
  payload: z.record(z.string(), z.unknown()),
  prevHash: z.string().nullable(),
  hash: z.string(),
  createdAt: z.date(),
});
export type AuditEntryDto = z.infer<typeof auditEntrySchema>;

/**
 * The result of re-walking a workspace's chain. `intact` true means every entry's
 * stored hash equals the recomputation from the running `prev`; false carries the
 * `brokenAtSeq` (a digit-string, like `seq`) of the first entry whose hash or
 * `prev_hash` linkage doesn't reconcile — the proof-of-tamper coordinate.
 */
export const chainVerificationSchema = z.object({
  intact: z.boolean(),
  brokenAtSeq: z.string().optional(),
});
export type ChainVerification = z.infer<typeof chainVerificationSchema>;
