/* oxlint-disable */
// Usage: npx tsx docs/qa/ac-7vf/seed.ts <organization-slug> [command]
// Seeds the rows the dashboard surfaces read, against the Postgres the running Hub uses.
// No real sprite is created: the trigger is saved with a recording provider, then the machine
// rows are moved to the status each scenario needs.
import { randomUUID } from "node:crypto";
import { OrganizationApiKeys } from "../../../src/auth/api-keys.js";
import {
  createSpriteActivation,
  type SpriteActivation,
  type SpriteProvider,
} from "../../../src/daemons/sprites/activation.js";
import type { ExecResult } from "../../../src/daemons/sprites/client.js";
import { UNLIMITED_TEMPLATE } from "../../../src/entitlements/catalog.js";
import { EntitlementsService } from "../../../src/entitlements/service.js";
import { createPostgresTestRuntime } from "../../../src/db/test-utils/runtime.js";
import { OrganizationTriggerStore } from "../../../src/triggers/store.js";

export const QA_PG = process.env.QA_PG ?? "postgres://qa:qa@127.0.0.1:55439/qa";
const ok: ExecResult = { stdout: "", stderr: "", exitCode: 0 };
const PREFIX = "/.sprite/languages/node/nvm/versions/node/v24.18.0";

export function recorder() {
  const calls: Array<{ call: string; args: unknown[] }> = [];
  const provider: SpriteProvider = {
    async create(input) {
      calls.push({ call: "create", args: [input] });
      return "sprite-id";
    },
    async exec(_name, argv) {
      if (argv[2] === "npm prefix -g") return { ...ok, stdout: `${PREFIX}\n` };
      return ok;
    },
    async service() {},
    async setMemory(name, memoryMb) {
      calls.push({ call: "setMemory", args: [name, memoryMb] });
    },
    async destroy(name) {
      calls.push({ call: "destroy", args: [name] });
    },
  };
  return { calls, provider };
}

export async function open() {
  const pg = await createPostgresTestRuntime(QA_PG);
  return pg;
}

export async function organizationId(pg: Awaited<ReturnType<typeof open>>, slug: string) {
  const rows = await pg.runtime.query<{ id: string }>(
    "select id from organization where slug = $1",
    [slug],
  );
  const id = rows.rows[0]?.id;
  if (id === undefined) throw new Error(`no organization ${slug}`);
  return id;
}

export async function storeFor(
  pg: Awaited<ReturnType<typeof open>>,
  orgId: string,
  provider: SpriteProvider | null,
) {
  const entitlements = new EntitlementsService(pg.database, { seats: async () => 0 });
  const apiKeys = new OrganizationApiKeys(pg.runtime, pg.locks);
  const jobs: Promise<void>[] = [];
  let activation: SpriteActivation | null = null;
  if (provider !== null) {
    const activate = createSpriteActivation({
      database: pg.database,
      apiKeys,
      connectionsForProject: () => (slug: string, value: string) => `resolved:${slug}.${value}`,
      hubOrigin: "http://127.0.0.1:3000",
      provider: () => provider,
    });
    activation = async (input) => {
      const started = await activate(input);
      if (started !== undefined) jobs.push(started.job);
      return started;
    };
  }
  return {
    store: new OrganizationTriggerStore(pg.database, orgId, entitlements, activation),
    entitlements,
    settled: () => Promise.all(jobs),
  };
}

export function spriteYaml(name: string) {
  return `name: ${name}
enabled: true
on:
  manual.run: {}
run:
  target:
    kind: sprite
    bootstrap: |
      echo bootstrapping
    cwd: /home/sprite/workspace/project
    memory: 16384
  agent: { provider: claude, mode: bypassPermissions }
  prompt: Deploy it.
  auto_archive: true
  max_runtime: 1h
  idle_timeout: 5m
`;
}

export function daemonYaml(name: string, daemonSlug: string) {
  return `name: ${name}
enabled: true
on:
  manual.run: {}
run:
  target: { daemon: ${daemonSlug}, cwd: /workspace }
  agent: { provider: claude, mode: bypassPermissions }
  prompt: Deploy it.
`;
}

/** An ordinary hand-enrolled daemon: a `daemon`-kind machine and the row that points at it. */
export async function seedPlainDaemon(
  pg: Awaited<ReturnType<typeof open>>,
  orgId: string,
  slug: string,
) {
  const machineId = randomUUID();
  const daemonId = randomUUID();
  await pg.runtime.query(
    `insert into machines (id, org_id, source, status, started_at)
     values ($1, $2, $3::jsonb, 'alive', now())`,
    [machineId, orgId, JSON.stringify({ kind: "daemon", daemonId })],
  );
  await pg.runtime.query(
    `insert into daemons (id, idempotency_key, enrollment_verifier, slug, machine_id, organization_id,
                          server_id, daemon_public_key, credential_verifier, scopes, status, presence,
                          connected_at, last_seen_at, created_at)
     values ($1, $2, 'verifier', $3, $4, $5, $6, 'public-key', 'credential', $7::jsonb, 'active', 'connected',
             now() - interval '2 hours', now(), now() - interval '2 days')`,
    [
      daemonId,
      `idem-${daemonId}`,
      slug,
      machineId,
      orgId,
      `server-${daemonId}`,
      JSON.stringify(["hub.execute"]),
    ],
  );
  return { daemonId, machineId };
}

/** The daemon a sprite gets at enrollment: slug is the trigger's name, machine is the sprite row. */
export async function bindSpriteDaemon(
  pg: Awaited<ReturnType<typeof open>>,
  orgId: string,
  machineId: string,
  slug: string,
) {
  const daemonId = randomUUID();
  await pg.runtime.query(
    `insert into daemons (id, idempotency_key, enrollment_verifier, slug, machine_id, organization_id,
                          server_id, daemon_public_key, credential_verifier, scopes, status, presence,
                          connected_at, last_seen_at, created_at)
     values ($1, $2, 'verifier', $3, $4, $5, $6, 'public-key', 'credential', $7::jsonb, 'active', 'connected',
             now() - interval '10 minutes', now(), now() - interval '1 hour')`,
    [
      daemonId,
      `idem-${daemonId}`,
      slug,
      machineId,
      orgId,
      `server-${daemonId}`,
      JSON.stringify(["hub.execute"]),
    ],
  );
  return daemonId;
}

export async function spriteMachineOf(pg: Awaited<ReturnType<typeof open>>, triggerId: string) {
  const rows = await pg.runtime.query<{ id: string; status: string }>(
    `select id, status from machines where source->>'kind' = 'sprite' and source->>'triggerId' = $1
       and status <> 'terminated' order by started_at desc limit 1`,
    [triggerId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw new Error(`no live sprite machine for ${triggerId}`);
  return row;
}

export async function setMachineStatus(
  pg: Awaited<ReturnType<typeof open>>,
  machineId: string,
  status: "spawning" | "alive" | "terminated",
) {
  await pg.runtime.query("update machines set status = $2 where id = $1", [machineId, status]);
}

/** A project configuration revision for the trigger's runtime project, for executions and runs. */
export async function revisionFor(
  pg: Awaited<ReturnType<typeof open>>,
  orgId: string,
  projectId: string,
) {
  const rows = await pg.runtime.query<{ id: string }>(
    "select id from project_configuration_revisions where project_id = $1 order by created_at desc limit 1",
    [projectId],
  );
  const existing = rows.rows[0]?.id;
  if (existing !== undefined) return existing;
  throw new Error(`no configuration revision for project ${projectId}`);
}

export async function seedExecution(
  pg: Awaited<ReturnType<typeof open>>,
  input: {
    orgId: string;
    projectId: string;
    revisionId: string;
    machineId: string | null;
    status: "spawning" | "running" | "succeeded" | "failed";
    startedAt?: string;
    stepRunId?: string;
  },
) {
  const id = randomUUID();
  await pg.runtime.query(
    `insert into agent_executions (id, organization_id, project_id, machine_id, status, started_at,
                                   configuration_revision_id, workflow_step_run_id)
     values ($1, $2, $3, $4, $5, coalesce($6::timestamptz, now()), $7, $8)`,
    [
      id,
      input.orgId,
      input.projectId,
      input.machineId,
      input.status,
      input.startedAt ?? null,
      input.revisionId,
      input.stepRunId ?? null,
    ],
  );
  if (input.stepRunId !== undefined) {
    await pg.runtime.query("update workflow_step_runs set agent_execution_id = $2 where id = $1", [
      input.stepRunId,
      id,
    ]);
  }
  return id;
}

/** A trigger run with one step, the way Activity reads it. */
export async function seedRun(
  pg: Awaited<ReturnType<typeof open>>,
  input: {
    orgId: string;
    projectId: string;
    revisionId: string;
    triggerName: string;
    provider: string;
    source: string;
    repo: string | null;
    status: "running" | "succeeded" | "failed";
  },
) {
  const receiptId = randomUUID();
  const runId = randomUUID();
  const stepRunId = randomUUID();
  await pg.runtime.query(
    `insert into provider_event_receipts (id, organization_id, provider, source, repo, delivery_id,
                                          payload, received_at)
     values ($1, $2, $3, $4, $5, $6, '{}'::jsonb, now() - interval '5 minutes')`,
    [receiptId, input.orgId, input.provider, input.source, input.repo, `delivery-${receiptId}`],
  );
  await pg.runtime.query(
    `insert into trigger_runs (id, organization_id, project_id, configuration_revision_id,
                               provider_event_receipt_id, configured_trigger_name, outcome, status,
                               prompt, deadline_at, created_at)
     values ($1, $2, $3, $4, $5, $6, 'accepted', $7, 'Deploy it.', now() + interval '1 hour',
             now() - interval '5 minutes')`,
    [
      runId,
      input.orgId,
      input.projectId,
      input.revisionId,
      receiptId,
      input.triggerName,
      input.status,
    ],
  );
  await pg.runtime.query(
    `insert into workflow_step_runs (id, trigger_run_id, step_id, ordinal, status, started_at)
     values ($1, $2, 'deploy-step', 0, 'running', now() - interval '5 minutes')`,
    [stepRunId, runId],
  );
  return { runId, stepRunId, receiptId };
}
