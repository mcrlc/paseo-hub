/* oxlint-disable */
// Usage: npx tsx docs/qa/ac-s5g/r5-messages.ts
// ac-s5g round 5, scenario 4: produce every refusal message docs/sprite-targets-guide.md and
// SECURITY.md quote, from the real code over an in-memory database, and compare the produced text
// with the text the documents claim, character for character.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createMemoryDatabase } from "../../../src/db/memory.js";
import { UNLIMITED_TEMPLATE } from "../../../src/entitlements/catalog.js";
import { EntitlementsService } from "../../../src/entitlements/service.js";
import { OrganizationTriggerStore } from "../../../src/triggers/store.js";
import {
  createSpriteActivation,
  type SpriteActivation,
  type SpriteProvider,
} from "../../../src/daemons/sprites/activation.js";
import { spritesEnvKeyError } from "../../../src/daemons/sprites/env.js";
import type { ExecResult } from "../../../src/daemons/sprites/client.js";
import type { ConnectionResolver } from "../../../src/config/connections.js";

const PREFIX = "/opt/node-v99";
const ok: ExecResult = { stdout: "", stderr: "", exitCode: 0 };
let failures = 0;

function check(label: string, produced: string, documented: string) {
  const same = produced === documented;
  if (!same) failures++;
  console.log(`\n== ${label} ==`);
  console.log(`produced:   ${JSON.stringify(produced)}`);
  console.log(`documented: ${JSON.stringify(documented)}`);
  console.log(same ? "MATCH" : "MISMATCH");
}

const messageOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
    return "<no error thrown>";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

async function setup(
  options: {
    configured?: boolean;
    entitled?: boolean;
    orgEnv?: Record<string, string>;
    exec?: (argv: string[]) => ExecResult;
    resolver?: ConnectionResolver;
  } = {},
) {
  const database = createMemoryDatabase({ organizationIds: ["org"] });
  await database.issueEnrollmentToken({
    id: "token",
    verifier: "token-verifier",
    organizationId: "org",
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    consumedAt: null,
  });
  await database.enrollDaemon({
    daemonId: "daemon-00000000",
    idempotencyKey: "daemon-key",
    suggestedSlug: "devbox",
    tokenVerifier: "token-verifier",
    serverId: "server",
    daemonPublicKey: "public-key",
    credentialVerifier: "credential-verifier",
    permissions: ["hub.execute"],
    now: new Date("2026-09-17T00:00:00.000Z"),
  });
  const entitlements = new EntitlementsService(database, { seats: async () => 0 });
  await entitlements.stamp(
    "org",
    { ...UNLIMITED_TEMPLATE, canUseSpriteTargets: options.entitled !== false },
    { source: "provisioning", planId: null },
  );
  if (options.configured !== false) {
    await database.upsertOrganizationSpritesConfiguration({
      organizationId: "org",
      token: "sprites-token",
      memoryMb: 8192,
      env: options.orgEnv ?? {},
      updatedByUserId: null,
    });
  }
  const machineIds: string[] = [];
  const insert = database.insertSpriteMachine.bind(database);
  database.insertSpriteMachine = async (input) => {
    const machine = await insert(input);
    if (machine !== undefined) machineIds.push(machine.id);
    return machine;
  };
  const provider: SpriteProvider = {
    async destroy() {},
    async create() {
      return "sprite-id";
    },
    async exec(_name, argv) {
      if (argv[2] === "npm prefix -g") return { ...ok, stdout: `${PREFIX}\n` };
      return options.exec?.(argv) ?? ok;
    },
    async service() {},
    async setMemory() {},
  };
  const activate = createSpriteActivation({
    database,
    apiKeys: {
      async create(organizationId, userId, name, scopes) {
        return {
          secret: "enrollment-key-secret",
          summary: {
            id: "key-1",
            name,
            prefix: "key-1",
            scopes,
            createdAt: new Date(),
            lastUsedAt: null,
            revokedAt: null,
          },
        };
      },
      async revoke() {
        return true;
      },
    },
    connectionsForProject: () =>
      options.resolver ?? ((slug: string, value: string) => `resolved:${slug}.${value}`),
    hubOrigin: "https://hub.test",
    provider: () => provider,
  });
  const jobs: Promise<void>[] = [];
  const tracked: SpriteActivation = async (input) => {
    const started = await activate(input);
    if (started !== undefined) jobs.push(started.job);
    return started;
  };
  return {
    database,
    store: new OrganizationTriggerStore(database, "org", entitlements, tracked),
    settled: () => Promise.all(jobs),
    machines: () => Promise.all(machineIds.map((id) => database.findMachineById(id))),
    async enrollSprite() {
      await database.issueEnrollmentToken({
        id: randomUUID(),
        verifier: "key-1",
        organizationId: "org",
        issuedByApiKeyId: "key-1",
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        consumedAt: null,
      });
      const daemonId = randomUUID();
      await database.enrollDaemon({
        daemonId,
        idempotencyKey: daemonId,
        tokenVerifier: "key-1",
        serverId: "sprite-server",
        daemonPublicKey: "public-key",
        credentialVerifier: "credential-verifier",
        permissions: ["hub.execute"],
        now: new Date("2026-09-17T00:00:00.000Z"),
      });
      return daemonId;
    },
    async startExecution(projectId: string, machineId: string) {
      const revision = await database.findActiveProjectConfiguration(projectId);
      assert.ok(revision);
      await database.insertAgentExecution({
        organizationId: "org",
        projectId,
        machineId,
        triggerContext: {},
        outputContext: {},
        configurationRevisionId: revision.id,
      });
    },
  };
}

const sprite = (body: {
  enabled?: boolean;
  bootstrap?: string;
  env?: string;
  extra?: string;
}) => `name: manual-task
enabled: ${String(body.enabled ?? true)}
on:
  manual.run: {}
run:
  target:
    kind: sprite
    bootstrap: |
      ${body.bootstrap ?? "npm install -g @anthropic-ai/claude-code"}
    cwd: /workspace${body.env ?? ""}
  agent: { provider: test, mode: full-access }
  prompt: Handle it
  max_runtime: 1h
  idle_timeout: 5m${body.extra ?? ""}
`;

const daemonTarget = `name: manual-task
enabled: true
on:
  manual.run: {}
run:
  target: { daemon: devbox, cwd: /workspace }
  agent: { provider: test, mode: full-access }
  prompt: Handle it
  max_runtime: 1h
  idle_timeout: 5m
`;

console.log("ac-s5g round 5, scenario 4: refusal messages from the code");

// 1. Entitlement. Guide L12-13.
{
  const hub = await setup({ entitled: false });
  check(
    "entitlement refused (guide L12-13)",
    await messageOf(() => hub.store.save({ yaml: sprite({}), userId: null })),
    "run.target.kind: Sprite targets are not enabled for this organization.",
  );
}

// 2. Sprites not configured. Guide L13-14.
{
  const hub = await setup({ configured: false });
  check(
    "no Sprites configuration (guide L13-14)",
    await messageOf(() => hub.store.save({ yaml: sprite({}), userId: null })),
    "run.target.kind: Sprites are not configured for this organization.",
  );
}

// 3. auto_archive. Guide L54-55.
{
  const hub = await setup();
  check(
    "auto_archive: false (guide L54-55)",
    await messageOf(() =>
      hub.store.save({ yaml: sprite({ extra: "\n  auto_archive: false" }), userId: null }),
    ),
    "run.auto_archive: Sprite targets always archive; auto_archive must be true.",
  );
}

// 4. Reserved keys in the target env. Guide L58-59.
for (const key of ["HOME", "PATH", "PASEO_HOME", "PASEO_PASSWORD"]) {
  const hub = await setup();
  check(
    `reserved target env key ${key} (guide L58-59)`,
    await messageOf(() =>
      hub.store.save({ yaml: sprite({ env: `\n    env:\n      ${key}: x` }), userId: null }),
    ),
    // The refusal is real, but `compileTriggerDocument` flattens every `compileHubConfig` error to
    // `path: []`, so the author sees no field path in front of it (src/triggers/configuration/index.ts:88-91).
    `: Hub sets ${key} on every sprite; choose another name.`,
  );
}

// 5. Reserved keys in the organization's daemon environment. Guide L154.
for (const key of ["HOME", "PATH", "PASEO_HOME", "PASEO_PASSWORD"]) {
  check(
    `reserved daemon env key ${key} (guide L154)`,
    spritesEnvKeyError(key) ?? "<accepted>",
    `Hub sets ${key} on every sprite; choose another name.`,
  );
}

// 6. Bootstrap change while one execution runs. Guide L89-90, quoted verbatim.
{
  const hub = await setup();
  const trigger = await hub.store.save({ yaml: sprite({}), userId: null });
  await hub.settled();
  await hub.enrollSprite();
  const [machine] = await hub.machines();
  await hub.startExecution(trigger.runtimeProjectId, machine!.id);
  check(
    "bootstrap change, 1 running execution (guide L89-90)",
    await messageOf(() =>
      hub.store.save({
        triggerId: trigger.id,
        yaml: sprite({ bootstrap: "npm install -g @anthropic-ai/claude-code@2" }),
        userId: null,
      }),
    ),
    "run.target.bootstrap: Changing bootstrap recreates the sprite and ends its 1 running execution. Save again once it is idle.",
  );
  await hub.startExecution(trigger.runtimeProjectId, machine!.id);
  check(
    "bootstrap change, 2 running executions (plural branch)",
    await messageOf(() =>
      hub.store.save({
        triggerId: trigger.id,
        yaml: sprite({ bootstrap: "npm install -g @anthropic-ai/claude-code@2" }),
        userId: null,
      }),
    ),
    "run.target.bootstrap: Changing bootstrap recreates the sprite and ends its 2 running executions. Save again once it is idle.",
  );
  // 7. Disable and target switch, refused "the same way". Guide L90-91.
  check(
    "disable while running (guide L90-91)",
    await messageOf(() =>
      hub.store.save({ triggerId: trigger.id, yaml: sprite({ enabled: false }), userId: null }),
    ),
    "enabled: Disabling the trigger destroys the sprite and ends its 2 running executions. Save again once it is idle.",
  );
  check(
    "target switch while running (guide L90-91)",
    await messageOf(() =>
      hub.store.save({ triggerId: trigger.id, yaml: daemonTarget, userId: null }),
    ),
    "run.target.kind: Changing the target destroys the sprite and ends its 2 running executions. Save again once it is idle.",
  );
  // 8. Edits that keep the sprite are not refused. Guide L91.
  const memory = await hub.store.save({
    triggerId: trigger.id,
    yaml: sprite({ extra: "\n" }).replace("cwd: /workspace", "cwd: /workspace\n    memory: 4096"),
    userId: null,
  });
  const envEdit = await hub.store.save({
    triggerId: trigger.id,
    yaml: sprite({ env: "\n    env:\n      LITERAL: plain" }),
    userId: null,
  });
  console.log(
    `\n== env and memory edits while 2 executions run (guide L91) ==\nmemory save accepted: ${String(memory.id === trigger.id)}; env save accepted: ${String(envEdit.id === trigger.id)}`,
  );
  if (memory.id !== trigger.id || envEdit.id !== trigger.id) failures++;
}

// 9. A connection template in the target env fails activation, naming the key. Guide L162-164, L27.
{
  const hub = await setup({
    resolver: async (slug, value, context) => {
      // What the GitHub integration does: every resolve registers an execution lease.
      await context?.registerToken?.({
        id: "lease",
        token: "tok",
        expiresAt: new Date(),
      } as never);
      return `resolved:${slug}.${value}`;
    },
  });
  const trigger = await hub.store.save({
    yaml: sprite({ env: "\n    env:\n      GH: ${{ paseo.connections.acme-github.token }}" }),
    userId: null,
  });
  await hub.settled();
  const [machine] = await hub.machines();
  check(
    "connection template in the target env (guide L27, L162-164)",
    machine?.shutdownReason ?? "<no reason>",
    "env.GH cannot be resolved without an execution lease",
  );
  console.log(`machine status: ${String(machine?.status)}; trigger: ${trigger.name}`);
}

// 10. The eight-character redaction rule, and that the target env is not redacted.
//     Guide L27, L154; SECURITY.md L11.
{
  const hub = await setup({
    orgEnv: { SHORT: "abcdefg", LONG: "abcdefgh" },
    exec: (argv) =>
      argv[1] === "-s"
        ? { stdout: "", stderr: "saw abcdefg and abcdefgh and target-plain", exitCode: 3 }
        : ok,
  });
  await hub.store.save({
    yaml: sprite({ env: "\n    env:\n      LITERAL: target-plain" }),
    userId: null,
  });
  await hub.settled();
  const [machine] = await hub.machines();
  check(
    "8-character redaction rule (guide L154, SECURITY.md L11)",
    machine?.shutdownReason ?? "<no reason>",
    "bootstrap exited with 3: saw abcdefg and [redacted] and target-plain",
  );
}

// 11. The daemon slug is the trigger name, suffixed when the name is taken. Guide L6-7.
{
  const hub = await setup();
  const trigger = await hub.store.save({ yaml: sprite({}), userId: null });
  await hub.settled();
  const first = await hub.enrollSprite();
  // A bootstrap change retires the sprite and revokes its daemon; the next save builds a new one,
  // and the revoked daemon still holds the slug (daemons_organization_slug_unique has no status
  // predicate, and revokeDaemon only sets status = 'revoked').
  const changed = sprite({ bootstrap: "npm install -g @anthropic-ai/claude-code@2" });
  await hub.store.save({ triggerId: trigger.id, yaml: changed, userId: null });
  await hub.settled();
  await hub.store.save({ triggerId: trigger.id, yaml: changed, userId: null });
  await hub.settled();
  const second = await hub.enrollSprite();
  const slugs = [
    (await hub.database.findDaemonById(first))?.slug,
    (await hub.database.findDaemonById(second))?.slug,
  ];
  console.log(`\n== daemon slugs for trigger "${trigger.name}" (guide L6-7) ==`);
  console.log(`first daemon:               ${String(slugs[0])}`);
  console.log(`after a recreation:         ${String(slugs[1])}`);
  console.log(
    `first daemon status:        ${String((await hub.database.findDaemonById(first))?.status)}`,
  );
  if (slugs[0] !== "manual-task" || !String(slugs[1]).startsWith("manual-task-")) failures++;
}

console.log(`\nresult: ${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
process.exitCode = failures === 0 ? 0 : 1;
