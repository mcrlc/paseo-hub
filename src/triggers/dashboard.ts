import type { AuthServer } from "../auth/server.js";
import { capabilitiesFor } from "../auth/organization-policy.js";
import type { Database, OrganizationSpriteRecord, OrganizationTriggerRecord } from "../db/types.js";
import { resolveRouteTenant } from "../projects/access.js";
import { ProjectCommandError } from "../projects/command-error.js";
import { parseCompiledHubConfig } from "../config/compiler.js";
import { spriteOutOfDate, spriteSpecs, type SpriteTarget } from "../daemons/sprites/activation.js";
import { projectTriggerForm } from "./configuration/editor.js";
import { OrganizationTriggerStore } from "./store.js";
import type { EntitlementsService } from "../entitlements/service.js";
import type { SpriteActivation } from "../daemons/sprites/activation.js";

export class SpriteBusyError extends Error {
  readonly code = "conflict";

  constructor(running: number) {
    super(
      `Recreating this sprite destroys it and ends its ${String(running)} running execution${running === 1 ? "" : "s"}. Try again once it is idle.`,
    );
    this.name = "SpriteBusyError";
  }
}

export class TriggerDashboard {
  constructor(
    private readonly database: Database,
    private readonly auth: AuthServer,
    private readonly entitlements: EntitlementsService | null,
    private readonly spriteActivation: SpriteActivation | null = null,
  ) {}

  async snapshot(request: Request, organizationSlug: string) {
    const { tenant } = await resolveRouteTenant(this.auth, this.database, request, {
      organizationSlug,
    });
    const store = new OrganizationTriggerStore(this.database, tenant.organization.id);
    const [triggers, daemons, connections, sprites] = await Promise.all([
      store.list(),
      this.database.listDaemonsForOrganization(tenant.organization.id),
      this.database.organizationConnectionUsage(tenant.organization.id),
      this.database.listOrganizationSprites(tenant.organization.id),
    ]);
    const latestSpriteFor = new Map<string, OrganizationSpriteRecord>();
    for (const sprite of sprites) {
      if (sprite.machine.source.kind !== "sprite") continue;
      const { triggerId } = sprite.machine.source;
      if (!latestSpriteFor.has(triggerId)) latestSpriteFor.set(triggerId, sprite);
    }
    const activity = (
      await Promise.all(triggers.map((trigger) => this.activityForTrigger(trigger)))
    )
      .flat()
      .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt))
      .slice(0, 100);
    return {
      organization: tenant.organization,
      canManage: capabilitiesFor(tenant.membership.role).manageResources,
      triggers: await Promise.all(
        triggers.map((trigger) =>
          triggerView(
            store,
            trigger,
            activity.find(({ triggerId }) => triggerId === trigger.id),
            latestSpriteFor.get(trigger.id),
          ),
        ),
      ),
      activity,
      daemons: daemons
        .filter(({ status }) => status === "active")
        .map(({ id, slug, presence }) => ({ id, slug, presence })),
      connections: [
        ...connections.slack.map(({ id, slug, teamName }) => ({
          id,
          slug,
          provider: "slack" as const,
          label: teamName,
        })),
        ...connections.discord.map(({ id, slug, guildName }) => ({
          id,
          slug,
          provider: "discord" as const,
          label: guildName,
        })),
        ...connections.github.map(({ id, slug, accountLogin }) => ({
          id,
          slug,
          provider: "github" as const,
          label: accountLogin,
        })),
        ...connections.linear.map(({ id, slug, linearOrganizationName }) => ({
          id,
          slug,
          provider: "linear" as const,
          label: linearOrganizationName,
        })),
      ],
    };
  }

  private async activityForTrigger(trigger: OrganizationTriggerRecord) {
    const migrationRevision = await this.database.findOrganizationTriggerMigrationRevision(
      trigger.id,
    );
    const evidence = record(migrationRevision?.sourceEvidence);
    const legacyProjectId = string(evidence?.["legacyProjectId"]);
    const legacyTriggerName =
      migrationRevision === undefined
        ? undefined
        : parseCompiledHubConfig(migrationRevision.normalizedConfiguration).triggers[0]?.name;
    const [current, historical] = await Promise.all([
      this.database.listProjectActivityRuns(trigger.runtimeProjectId, 100),
      legacyProjectId === undefined
        ? Promise.resolve([])
        : this.database.listProjectActivityRuns(legacyProjectId, 100),
    ]);
    const runs = [...current, ...historical].filter(
      ({ run }) =>
        current.some((candidate) => candidate.run.id === run.id) ||
        run.configuredTriggerName === legacyTriggerName,
    );
    const machineStatuses = new Map(
      (
        await this.database.listSpriteRunStatuses(
          trigger.organizationId,
          runs.map(({ run }) => run.id),
        )
      ).map(({ triggerRunId, status }) => [triggerRunId, status]),
    );
    return runs.map(({ run, receipt }) => ({
      id: run.id,
      triggerId: trigger.id,
      triggerName: trigger.name,
      provider: receipt.provider,
      source: receipt.source,
      repo: receipt.repo,
      status: run.status,
      receivedAt: receipt.receivedAt.toISOString(),
      machineStatus: machineStatuses.get(run.id) ?? null,
    }));
  }

  async recreateSprite(request: Request, organizationSlug: string, triggerId: string) {
    const { account, tenant } = await resolveRouteTenant(this.auth, this.database, request, {
      organizationSlug,
    });
    if (!capabilitiesFor(tenant.membership.role).manageResources) {
      throw new ProjectCommandError("forbidden");
    }
    const trigger = (
      await new OrganizationTriggerStore(this.database, tenant.organization.id).list()
    ).find(({ id }) => id === triggerId);
    if (trigger === undefined) throw new ProjectCommandError("notFound");
    const machine = await this.database.findLiveSpriteMachine(triggerId);
    if (machine === undefined) return;
    const running = await this.database.findRunningAgentExecutionsForMachine(machine.id);
    if (running.length > 0) throw new SpriteBusyError(running.length);
    await this.spriteActivation?.({
      trigger,
      target: undefined,
      userId: account.account.id,
      reason: "recreated from the dashboard",
    });
  }

  async save(
    request: Request,
    organizationSlug: string,
    input: { triggerId?: string; yaml: string },
  ) {
    const { account, tenant } = await resolveRouteTenant(this.auth, this.database, request, {
      organizationSlug,
    });
    if (!capabilitiesFor(tenant.membership.role).manageResources) {
      throw new ProjectCommandError("forbidden");
    }
    return new OrganizationTriggerStore(
      this.database,
      tenant.organization.id,
      this.entitlements,
      this.spriteActivation,
    ).save({
      ...(input.triggerId === undefined ? {} : { triggerId: input.triggerId }),
      yaml: input.yaml,
      userId: account.account.id,
    });
  }
}

async function triggerView(
  store: OrganizationTriggerStore,
  trigger: OrganizationTriggerRecord,
  lastTriggered:
    | { provider: string; source: string; status: string; receivedAt: string }
    | undefined,
  sprite: OrganizationSpriteRecord | undefined,
) {
  const revision = await store.activeRevision(trigger);
  const evidence = record(revision.sourceEvidence);
  const event = triggerEvent(revision.yaml, lastTriggered?.source);
  const operational =
    lastTriggered === undefined
      ? null
      : { status: lastTriggered.status, receivedAt: lastTriggered.receivedAt };
  if (trigger.format === "legacy_multistep") {
    return {
      id: trigger.id,
      name: trigger.name,
      enabled: trigger.enabled,
      format: trigger.format,
      yaml: revision.yaml,
      updatedAt: trigger.updatedAt.toISOString(),
      blockers: stringArray(evidence?.["conversionBlockers"]),
      draft: null,
      event,
      provider: triggerProvider(event, lastTriggered?.provider),
      lastTriggered: operational,
      sprite: null,
    };
  }
  const projection = projectTriggerForm(revision.yaml);
  return {
    id: trigger.id,
    name: trigger.name,
    enabled: trigger.enabled,
    format: trigger.format,
    yaml: revision.yaml,
    updatedAt: trigger.updatedAt.toISOString(),
    blockers: [],
    draft: projection.status === "editable" ? projection.value : null,
    event: projection.status === "editable" ? projection.value.event : event,
    provider: triggerProvider(
      projection.status === "editable" ? projection.value.event : event,
      lastTriggered?.provider,
    ),
    lastTriggered: operational,
    sprite: spriteView(revision.normalizedConfiguration, sprite),
  };
}

function spriteView(
  normalizedConfiguration: unknown,
  sprite: OrganizationSpriteRecord | undefined,
) {
  const target = parseCompiledHubConfig(normalizedConfiguration).environments.find(
    (environment): environment is SpriteTarget => environment.kind === "sprite",
  );
  if (target === undefined) return null;
  if (sprite === undefined || sprite.machine.source.kind !== "sprite") {
    return { status: null, name: null, memoryMb: null, lastRunAt: null, stale: false };
  }
  return {
    status: sprite.machine.status,
    name: sprite.machine.source.spriteName,
    memoryMb: spriteSpecs(sprite.machine).memoryMb ?? null,
    lastRunAt: sprite.lastRunAt?.toISOString() ?? null,
    stale: sprite.machine.status !== "terminated" && spriteOutOfDate(sprite.machine, target),
  };
}

function triggerEvent(yaml: string, fallback: string | undefined): string {
  const inline = /^on:\s+([a-z]+(?:\.[a-z_]+)+)\s*$/mu.exec(yaml)?.[1];
  if (inline !== undefined) return inline;
  const nested = /^on:\s*$[\s\S]*?^\s{2}([a-z]+(?:\.[a-z_]+)+):\s*$/mu.exec(yaml)?.[1];
  return nested ?? fallback ?? "manual.run";
}

function triggerProvider(
  event: string,
  fallback: string | undefined,
): "github" | "discord" | "slack" | "linear" | "manual" | "schedule" {
  const provider = event.split(".")[0] ?? fallback;
  if (
    provider === "schedule" ||
    provider === "github" ||
    provider === "discord" ||
    provider === "slack" ||
    provider === "linear"
  ) {
    return provider;
  }
  return "manual";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
