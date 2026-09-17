/* oxlint-disable */
// Shared Postgres setup for the ac-vni scripts. Expects a Postgres at QA_PG (default below), e.g.
//   docker run -d --rm --name qa-acvni-pg -e POSTGRES_PASSWORD=qa -e POSTGRES_USER=qa -e POSTGRES_DB=qa -p 55437:5432 postgres:17-alpine
import { randomUUID } from "node:crypto";
import { OrganizationApiKeys } from "../../../src/auth/api-keys.js";
import {
  createSpriteActivation,
  type SpriteActivation,
  type SpriteProvider,
} from "../../../src/daemons/sprites/activation.js";
import type { ConnectionResolver } from "../../../src/config/connections.js";
import { UNLIMITED_TEMPLATE } from "../../../src/entitlements/catalog.js";
import { EntitlementsService } from "../../../src/entitlements/service.js";
import { createPostgresTestRuntime } from "../../../src/db/test-utils/runtime.js";
import { OrganizationTriggerStore } from "../../../src/triggers/store.js";

export const QA_PG = process.env.QA_PG ?? "postgres://qa:qa@127.0.0.1:55437/qa";

export async function openPostgres() {
  return createPostgresTestRuntime(QA_PG);
}

export type Pg = Awaited<ReturnType<typeof openPostgres>>;

export async function seedOrganization(pg: Pg, { configured = true } = {}) {
  const organizationId = `org-${randomUUID()}`;
  await pg.runtime.query("insert into organization (id, name, slug) values ($1, $2, $3)", [
    organizationId,
    "QA ac-vni",
    `qa-${organizationId.slice(4, 12)}`,
  ]);
  const entitlements = new EntitlementsService(pg.database, { seats: async () => 0 });
  await entitlements.stamp(organizationId, UNLIMITED_TEMPLATE, {
    source: "provisioning",
    planId: null,
  });
  await entitlements.override(organizationId, { canUseSpriteTargets: true }, "qa", "ac-vni");
  if (configured) {
    await pg.database.upsertOrganizationSpritesConfiguration({
      organizationId,
      token: "sprites-token-fake",
      memoryMb: 8192,
      updatedByUserId: null,
    });
  }
  return { organizationId, entitlements };
}

/** Real API keys, real store; provider and resolver injected. Tracks every activation job. */
export function activationStore(
  pg: Pg,
  org: Awaited<ReturnType<typeof seedOrganization>>,
  provider: SpriteProvider | null,
  resolver: ConnectionResolver = (slug, value) => `resolved:${slug}.${value}`,
) {
  const apiKeys = new OrganizationApiKeys(pg.runtime, pg.locks);
  const jobs: Promise<void>[] = [];
  let activation: SpriteActivation | null = null;
  if (provider !== null) {
    const activate = createSpriteActivation({
      database: pg.database,
      apiKeys,
      connectionsForProject: () => resolver,
      hubOrigin: "https://hub.qa.test",
      provider: () => provider,
    });
    activation = async (input) => {
      const started = await activate(input);
      if (started !== undefined) jobs.push(started.job);
      return started;
    };
  }
  const store = new OrganizationTriggerStore(
    pg.database,
    org.organizationId,
    org.entitlements,
    activation,
  );
  return { store, apiKeys, settled: () => Promise.all(jobs) };
}

export async function spriteMachines(pg: Pg, triggerId: string) {
  const rows = await pg.runtime.query<Record<string, unknown>>(
    `select id, status, source, specs, shutdown_reason, terminated_at is not null as terminated_at_set from machines
     where source->>'kind' = 'sprite' and source->>'triggerId' = $1 order by started_at`,
    [triggerId],
  );
  return rows.rows;
}

export async function apiKeyRows(pg: Pg, organizationId: string) {
  const rows = await pg.runtime.query<Record<string, unknown>>(
    `select id, name, scopes, revoked_at is not null as revoked from organization_api_keys
     where organization_id = $1 order by created_at`,
    [organizationId],
  );
  return rows.rows;
}

export function spriteYaml(
  overrides: { bootstrap?: string; env?: string; enabled?: boolean; prompt?: string } = {},
) {
  const bootstrap =
    overrides.bootstrap ?? "echo bootstrapping\nmkdir -p /home/sprite/workspace/project";
  return `name: qa-sprite
enabled: ${overrides.enabled ?? true}
on:
  manual.run: {}
run:
  target:
    kind: sprite
    bootstrap: |
${bootstrap
  .split("\n")
  .map((line) => `      ${line}`)
  .join("\n")}
    cwd: /home/sprite/workspace/project
    memory: 16384
    env:
${(overrides.env ?? "LITERAL: plain")
  .split("\n")
  .map((line) => `      ${line}`)
  .join("\n")}
  agent: { provider: claude, mode: bypassPermissions }
  prompt: ${overrides.prompt ?? "Call the finish_execution MCP tool exactly once. Do not use curl, shell, or direct HTTP."}
  auto_archive: true
  max_runtime: 1h
  idle_timeout: 5m
`;
}
