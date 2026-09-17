import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "vitest";
import type { ConnectionResolver } from "../../config/connections.js";
import { createMemoryDatabase } from "../../db/memory.js";
import { UNLIMITED_TEMPLATE } from "../../entitlements/catalog.js";
import { EntitlementsService } from "../../entitlements/service.js";
import { OrganizationTriggerStore } from "../../triggers/store.js";
import {
  createSpriteActivation,
  type SpriteActivation,
  type SpriteProvider,
} from "./activation.js";
import { SpritesError, type ExecResult } from "./client.js";

const PREFIX = "/.sprite/languages/node/nvm/versions/node/v24.18.0";
const PATH = `${PREFIX}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;

describe("sprite activation", () => {
  it("creates, bootstraps, and enrolls the sprite in order with the service env resolved", async () => {
    const hub = await setup();
    const trigger = await hub.store.save({ yaml: spriteYaml(), userId: "user" });
    await hub.settled();

    const [machine] = await hub.spriteMachines();
    const name = `trigger-${trigger.id}`;
    assert.equal(machine?.status, "spawning");
    assert.deepEqual(machine?.source, {
      kind: "sprite",
      triggerId: trigger.id,
      spriteName: name,
      apiKeyId: "key-1",
    });
    assert.deepEqual(machine?.specs, {
      bootstrapHash: createHash("sha256")
        .update("npm install -g @anthropic-ai/claude-code\n")
        .digest("hex"),
      memoryMb: 16384,
    });
    assert.deepEqual(hub.keys, [
      {
        organizationId: "org",
        userId: "user",
        name: `Sprite ${trigger.id}`,
        scopes: ["daemons:enroll"],
      },
    ]);
    const password = hub.serviceEnvs[0]?.["PASEO_PASSWORD"];
    const connectScript = hub.execArgvs[2]?.[2];
    assert.match(password ?? "", /^[\w-]{43}$/u);
    const daemonEnv = { HOME: "/home/sprite", PASEO_HOME: "/home/sprite/.paseo", PATH };
    assert.deepEqual(hub.calls, [
      { call: "create", args: [{ name, memoryMb: 16384 }] },
      {
        call: "exec",
        args: [name, ["sh", "-c", "npm install -g @getpaseo/cli"], { env: { PATH } }],
      },
      {
        call: "exec",
        args: [
          name,
          ["sh", "-s"],
          { env: { PATH }, stdin: "npm install -g @anthropic-ai/claude-code\n" },
        ],
      },
      {
        call: "service",
        args: [
          name,
          "paseo",
          {
            cmd: `${PREFIX}/bin/paseo`,
            args: [
              "start",
              "--foreground",
              "--listen",
              "127.0.0.1:6767",
              "--no-relay",
              "--no-web-ui",
            ],
            env: {
              ...daemonEnv,
              PASEO_PASSWORD: password,
              ANTHROPIC_API_KEY: "resolved:anthropic.api_key",
              LITERAL: "plain",
            },
            dir: "/home/sprite",
          },
        ],
      },
      {
        call: "exec",
        args: [
          name,
          ["sh", "-c", connectScript, "sh", "https://hub.test", "secret-1"],
          { env: { ...daemonEnv, PASEO_PASSWORD: password } },
        ],
      },
    ]);
    assert.match(
      connectScript ?? "",
      /paseo hub connect "\$1" --host 127\.0\.0\.1:6767 --api-key "\$2" --permission hub\.execute/u,
    );
    assert.deepEqual(hub.revoked, []);
  });

  it("terminates the machine with the bootstrap output and stops when bootstrap exits non-zero", async () => {
    const hub = await setup({
      exec: (argv) =>
        argv[1] === "-s" ? { stdout: "", stderr: "clone failed", exitCode: 3 } : success,
    });
    await hub.store.save({ yaml: spriteYaml(), userId: null });
    await hub.settled();

    const [machine] = await hub.spriteMachines();
    assert.equal(machine?.status, "terminated");
    assert.equal(machine?.shutdownReason, "bootstrap exited with 3: clone failed");
    assert.deepEqual(
      hub.calls.map(({ call }) => call),
      ["create", "exec", "exec"],
    );
    assert.deepEqual(hub.revoked, ["key-1"]);
  });

  it("terminates the machine with the provider message when create fails", async () => {
    const hub = await setup({
      create: () => {
        throw new SpritesError(409, "sprite already exists");
      },
    });
    await hub.store.save({ yaml: spriteYaml(), userId: null });
    await hub.settled();

    const [machine] = await hub.spriteMachines();
    assert.equal(machine?.status, "terminated");
    assert.equal(machine?.shutdownReason, "Sprites API 409: sprite already exists");
    assert.deepEqual(
      hub.calls.map(({ call }) => call),
      ["create"],
    );
  });

  it("fails the job naming the env key when a template needs an execution lease", async () => {
    const hub = await setup({
      resolver: async (slug, value, context) => {
        await context?.registerToken?.({ provider: "github", token: "t", expiresAt: 0 });
        return `${slug}.${value}`;
      },
    });
    await hub.store.save({ yaml: spriteYaml(), userId: null });
    await hub.settled();

    const [machine] = await hub.spriteMachines();
    assert.equal(machine?.status, "terminated");
    assert.equal(
      machine?.shutdownReason,
      "env.ANTHROPIC_API_KEY cannot be resolved without an execution lease",
    );
    assert.deepEqual(
      hub.calls.map(({ call }) => call),
      ["create", "exec", "exec"],
    );
  });

  it("does not create a second sprite while the trigger's machine is not terminated", async () => {
    const hub = await setup();
    const trigger = await hub.store.save({ yaml: spriteYaml(), userId: null });
    await hub.settled();
    await hub.store.save({
      triggerId: trigger.id,
      yaml: spriteYaml().replace("Handle it", "Handle it again"),
      userId: null,
    });
    await hub.settled();

    assert.equal((await hub.spriteMachines()).length, 1);
    assert.equal(hub.calls.filter(({ call }) => call === "create").length, 1);
    assert.equal(hub.keys.length, 1);
  });

  it("rejects activation without a Sprites configuration and keeps the previous revision", async () => {
    const hub = await setup({ configured: false });
    const daemon = await hub.store.save({ yaml: daemonYaml, userId: null });

    await assert.rejects(
      hub.store.save({ triggerId: daemon.id, yaml: spriteYaml(), userId: null }),
      /run\.target\.kind: Sprites are not configured for this organization\./u,
    );
    const [unchanged] = await hub.store.list();
    assert.equal((await hub.store.activeRevision(unchanged!)).yaml, daemonYaml);
    assert.deepEqual(hub.calls, []);
    assert.deepEqual(await hub.spriteMachines(), []);
  });
});

const success: ExecResult = { stdout: "", stderr: "", exitCode: 0 };

async function setup(
  options: {
    configured?: boolean;
    create?: () => void;
    exec?: (argv: string[]) => ExecResult;
    resolver?: ConnectionResolver;
  } = {},
) {
  const database = createMemoryDatabase({ organizationIds: ["org"] });
  await enrollDevbox(database);
  const entitlements = new EntitlementsService(database, { seats: async () => 0 });
  await entitlements.stamp("org", UNLIMITED_TEMPLATE, { source: "provisioning", planId: null });
  if (options.configured !== false) {
    await database.upsertOrganizationSpritesConfiguration({
      organizationId: "org",
      token: "sprites-token",
      memoryMb: 8192,
      updatedByUserId: null,
    });
  }
  const machineIds: string[] = [];
  const insertSpriteMachine = database.insertSpriteMachine.bind(database);
  database.insertSpriteMachine = async (input) => {
    const machine = await insertSpriteMachine(input);
    if (machine !== undefined) machineIds.push(machine.id);
    return machine;
  };
  const calls: Array<{ call: string; args: unknown[] }> = [];
  const execArgvs: string[][] = [];
  const serviceEnvs: Record<string, string>[] = [];
  const keys: unknown[] = [];
  const revoked: string[] = [];
  const provider: SpriteProvider = {
    async create(input) {
      calls.push({ call: "create", args: [input] });
      options.create?.();
      return "sprite-id";
    },
    async exec(name, argv, execOptions) {
      calls.push({ call: "exec", args: [name, argv, execOptions] });
      execArgvs.push(argv);
      return options.exec?.(argv) ?? success;
    },
    async service(name, service, definition) {
      calls.push({ call: "service", args: [name, service, definition] });
      serviceEnvs.push(definition.env);
    },
  };
  const activate = createSpriteActivation({
    database,
    apiKeys: {
      async create(organizationId, userId, name, scopes) {
        keys.push({ organizationId, userId, name, scopes });
        const id = `key-${keys.length}`;
        return {
          secret: `secret-${keys.length}`,
          summary: {
            id,
            name,
            prefix: id,
            scopes,
            createdAt: new Date(),
            lastUsedAt: null,
            revokedAt: null,
          },
        };
      },
      async revoke(_organizationId, id) {
        revoked.push(id);
        return true;
      },
    },
    connectionsForProject: () => options.resolver ?? ((slug, value) => `resolved:${slug}.${value}`),
    hubOrigin: "https://hub.test",
    provider: (token) => {
      assert.equal(token, "sprites-token");
      return provider;
    },
  });
  const jobs: Promise<void>[] = [];
  const tracked: SpriteActivation = async (input) => {
    const started = await activate(input);
    if (started !== undefined) jobs.push(started.job);
    return started;
  };
  const store = new OrganizationTriggerStore(database, "org", entitlements, tracked);
  return {
    store,
    calls,
    execArgvs,
    serviceEnvs,
    keys,
    revoked,
    settled: () => Promise.all(jobs),
    spriteMachines: () => Promise.all(machineIds.map((id) => database.findMachineById(id))),
  };
}

const daemonYaml = `name: manual-task
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

function spriteYaml(): string {
  return `name: manual-task
enabled: true
on:
  manual.run: {}
run:
  target:
    kind: sprite
    bootstrap: |
      npm install -g @anthropic-ai/claude-code
    cwd: /workspace
    memory: 16384
    env:
      ANTHROPIC_API_KEY: \${{ paseo.connections.anthropic.api_key }}
      LITERAL: plain
  agent: { provider: test, mode: full-access }
  prompt: Handle it
  max_runtime: 1h
  idle_timeout: 5m
`;
}

async function enrollDevbox(database: ReturnType<typeof createMemoryDatabase>) {
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
    now: new Date("2026-08-29T21:00:00.000Z"),
  });
}
