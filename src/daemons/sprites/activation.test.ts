import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, it, vi } from "vitest";
import type { ConnectionResolver } from "../../config/connections.js";
import { createMemoryDatabase } from "../../db/memory.js";
import { UNLIMITED_TEMPLATE } from "../../entitlements/catalog.js";
import { EntitlementsService } from "../../entitlements/service.js";
import { logger } from "../../logger.js";
import { OrganizationTriggerStore } from "../../triggers/store.js";
import {
  createSpriteActivation,
  createSpriteServiceRewrite,
  spriteSpecs,
  type SpriteActivation,
  type SpriteProvider,
} from "./activation.js";
import { SpritesError, type ExecResult } from "./client.js";

const PREFIX = "/opt/node-v99";
const PATH = `${PREFIX}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;

describe("sprite activation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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
      envHash: createHash("sha256")
        .update(
          JSON.stringify([
            ["ANTHROPIC_API_KEY", "${{ paseo.connections.anthropic.api_key }}"],
            ["LITERAL", "plain"],
          ]),
        )
        .digest("hex"),
      memoryMb: 16384,
      npmPrefix: PREFIX,
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
    const connectScript = hub.execArgvs[3]?.[2];
    assert.match(password ?? "", /^[\w-]{43}$/u);
    const daemonEnv = {
      HOME: "/home/sprite",
      PASEO_HOME: "/home/sprite/.paseo",
      PATH,
      PASEO_LISTEN: "127.0.0.1:6767",
      PASEO_RELAY_ENABLED: "false",
      PASEO_WEB_UI_ENABLED: "false",
    };
    const mergedEnv = {
      ORG_ONLY: "org-value",
      ANTHROPIC_API_KEY: "resolved:anthropic.api_key",
      LITERAL: "plain",
    };
    assert.deepEqual(hub.calls, [
      { call: "destroy", args: [name] },
      { call: "create", args: [{ name, memoryMb: 16384 }] },
      { call: "exec", args: [name, ["sh", "-c", "npm prefix -g"], undefined] },
      {
        call: "exec",
        args: [name, ["sh", "-c", "npm install -g @getpaseo/cli@0.9.1"], { env: { PATH } }],
      },
      {
        call: "exec",
        args: [
          name,
          ["sh", "-s"],
          { env: { PATH, ...mergedEnv }, stdin: "npm install -g @anthropic-ai/claude-code\n" },
        ],
      },
      {
        call: "service",
        args: [
          name,
          "paseo",
          {
            cmd: `${PREFIX}/bin/paseo`,
            args: ["daemon", "run", "--home", "/home/sprite/.paseo"],
            env: { ...daemonEnv, PASEO_PASSWORD: password, ...mergedEnv },
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

  it("terminates the machine, stops, and destroys the sprite when bootstrap exits non-zero", async () => {
    const info = vi.spyOn(logger, "info");
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
      ["destroy", "create", "exec", "exec", "exec", "destroy"],
    );
    assert.deepEqual(hub.revoked, ["key-1"]);
    assert.ok(
      info.mock.calls.some(
        ([, message]) => message === "sprite activation: destroyed after failure",
      ),
    );
  });

  it("scrubs long organization values only, from the failure reason and the connect log", async () => {
    const info = vi.spyOn(logger, "info");
    const leak = "org-secret-value abc plain resolved:anthropic.api_key secret-1";
    const orgEnv = { ORG_SECRET: "org-secret-value", TINY: "abc" };
    const hub = await setup({
      orgEnv,
      exec: (argv) =>
        argv[1] === "-s"
          ? { stdout: leak, stderr: "", exitCode: 3 }
          : { stdout: leak, stderr: "", exitCode: 0 },
    });
    await hub.store.save({ yaml: spriteYaml(), userId: null });
    await hub.settled();

    const [machine] = await hub.spriteMachines();
    assert.equal(
      machine?.shutdownReason,
      "bootstrap exited with 3: [redacted] abc plain resolved:anthropic.api_key [redacted]",
    );

    const connected = await setup({
      orgEnv,
      exec: () => ({ stdout: leak, stderr: "", exitCode: 0 }),
    });
    await connected.store.save({ yaml: spriteYaml(), userId: null });
    await connected.settled();
    const logged = JSON.stringify(info.mock.calls);
    assert.match(
      logged,
      /"output":"\[redacted\] abc plain resolved:anthropic.api_key \[redacted\]"/u,
    );
    assert.doesNotMatch(logged, /org-secret-value/u);
  });

  it("keeps the failure reason when destroying the failed sprite also fails", async () => {
    const info = vi.spyOn(logger, "info");
    const hub = await setup({
      destroy: () => {
        throw new SpritesError(500, "destroy unavailable");
      },
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
      ["destroy", "create", "exec", "exec", "exec", "destroy"],
    );
    assert.deepEqual(hub.revoked, ["key-1"]);
    assert.ok(
      !info.mock.calls.some(
        ([, message]) => message === "sprite activation: destroyed after failure",
      ),
    );
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
      ["destroy", "create", "destroy"],
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
      ["destroy", "create", "exec", "exec", "destroy"],
    );
  });

  it("rewrites the daemon service of every alive sprite with the merged env", async () => {
    const info = vi.spyOn(logger, "info");
    let failing = "";
    const hub = await setup({
      service: (name) => {
        if (name === failing) throw new SpritesError(500, "service unavailable");
      },
    });
    const triggers = [];
    for (const name of ["alive-a", "alive-b", "spawning", "terminated"]) {
      triggers.push(
        await hub.store.save({
          yaml: spriteYaml().replace("name: manual-task", `name: ${name}`),
          userId: null,
        }),
      );
    }
    await hub.settled();
    const [aliveA, aliveB, spawning, terminated] = await hub.spriteMachines();
    assert.equal(spawning?.status, "spawning");
    failing = `trigger-${triggers[0]!.id}`;
    await hub.database.transitionMachine(aliveA!.id, "alive");
    await hub.database.transitionMachine(aliveB!.id, "alive");
    await hub.database.transitionMachine(terminated!.id, "terminated");
    hub.calls.length = 0;
    hub.serviceEnvs.length = 0;

    await hub.rewrite("org");

    assert.deepEqual(
      hub.calls.map(({ call, args }) => [call, args[0], args[1]]),
      [
        ["service", failing, "paseo"],
        ["service", `trigger-${triggers[1]!.id}`, "paseo"],
      ],
    );
    assert.deepEqual(
      info.mock.calls
        .filter(([, message]) => message === "sprite service rewritten")
        .map(([fields]) => fields),
      [{ triggerId: triggers[1]!.id, sprite: `trigger-${triggers[1]!.id}`, envKeys: 10 }],
    );
    for (const env of hub.serviceEnvs) {
      assert.match(env["PASEO_PASSWORD"] ?? "", /^[\w-]{43}$/u);
      assert.deepEqual(
        { ...env, PASEO_PASSWORD: undefined },
        {
          HOME: "/home/sprite",
          PASEO_HOME: "/home/sprite/.paseo",
          PATH,
          PASEO_LISTEN: "127.0.0.1:6767",
          PASEO_RELAY_ENABLED: "false",
          PASEO_WEB_UI_ENABLED: "false",
          PASEO_PASSWORD: undefined,
          ORG_ONLY: "org-value",
          ANTHROPIC_API_KEY: "resolved:anthropic.api_key",
          LITERAL: "plain",
        },
      );
    }
  });

  it("reports and resolves when the rewrite cannot list the organization's triggers", async () => {
    const hub = await setup();
    await hub.store.save({ yaml: spriteYaml(), userId: null });
    await hub.settled();
    hub.database.listOrganizationTriggers = () => Promise.reject(new Error("database is down"));
    hub.calls.length = 0;

    await hub.rewrite("org");

    assert.deepEqual(hub.calls, []);
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

  it("rejects activation on a Hub that cannot provision sprites", async () => {
    const hub = await setup({ unavailable: true });

    await assert.rejects(
      hub.store.save({ yaml: spriteYaml(), userId: null }),
      /run\.target\.kind: Sprite targets are unavailable on this Hub: no public base URL or API keys configured\./u,
    );
    assert.deepEqual(await hub.store.list(), []);
  });
});

describe("sprite trigger edits", () => {
  it("destroys the sprite, revokes its daemon, and terminates the row when the bootstrap changes", async () => {
    const hub = await setup();
    const trigger = await hub.store.save({ yaml: spriteYaml(), userId: null });
    await hub.settled();
    const daemonId = await hub.enrollSprite();
    hub.calls.length = 0;

    await hub.store.save({
      triggerId: trigger.id,
      yaml: spriteYaml().replace("@anthropic-ai/claude-code", "@anthropic-ai/claude-code@2"),
      userId: null,
    });
    await hub.settled();

    const [machine] = await hub.spriteMachines();
    assert.equal(machine?.status, "terminated");
    assert.equal(machine?.shutdownReason, "bootstrap changed");
    assert.deepEqual(hub.calls, [{ call: "destroy", args: [`trigger-${trigger.id}`] }]);
    assert.equal((await hub.database.findDaemonById(daemonId))?.status, "revoked");
  });

  it("frees the retired daemon's slug so the recreated sprite enrolls as the trigger", async () => {
    const hub = await setup();
    const trigger = await hub.store.save({ yaml: spriteYaml(), userId: null });
    await hub.settled();
    const retired = await hub.enrollSprite();
    assert.equal((await hub.database.findDaemonById(retired))?.slug, "manual-task");

    await hub.store.save({
      triggerId: trigger.id,
      yaml: spriteYaml().replace("@anthropic-ai/claude-code", "@anthropic-ai/claude-code@2"),
      userId: null,
    });
    await hub.settled();
    await hub.store.save({
      triggerId: trigger.id,
      yaml: spriteYaml().replace("@anthropic-ai/claude-code", "@anthropic-ai/claude-code@3"),
      userId: null,
    });
    await hub.settled();
    const recreated = await hub.enrollSprite("key-2");

    assert.equal(
      (await hub.database.findDaemonById(retired))?.slug,
      `manual-task-revoked-${retired.slice(0, 8)}`,
    );
    assert.equal((await hub.database.findDaemonById(recreated))?.slug, "manual-task");
  });

  it("refuses a bootstrap change while an execution is running on the sprite", async () => {
    const hub = await setup();
    const trigger = await hub.store.save({ yaml: spriteYaml(), userId: null });
    await hub.settled();
    await hub.enrollSprite();
    const [machine] = await hub.spriteMachines();
    await hub.startExecution(trigger.runtimeProjectId, machine!.id);
    hub.calls.length = 0;

    await assert.rejects(
      hub.store.save({
        triggerId: trigger.id,
        yaml: spriteYaml().replace("@anthropic-ai/claude-code", "@anthropic-ai/claude-code@2"),
        userId: null,
      }),
      /run\.target\.bootstrap: Changing bootstrap recreates the sprite and ends its 1 running execution\. Save again once it is idle\./u,
    );
    assert.deepEqual(hub.calls, []);
    assert.equal((await hub.spriteMachines())[0]?.status, "alive");
    assert.equal((await hub.store.activeRevision(trigger)).yaml, spriteYaml());
  });

  it("rewrites the daemon service when only the target env changes", async () => {
    const hub = await setup();
    const trigger = await hub.store.save({ yaml: spriteYaml(), userId: null });
    await hub.settled();
    await hub.enrollSprite();
    hub.calls.length = 0;
    hub.serviceEnvs.length = 0;

    await hub.store.save({
      triggerId: trigger.id,
      yaml: spriteYaml().replace("LITERAL: plain", "LITERAL: rotated"),
      userId: null,
    });
    await hub.settled();

    const [machine] = await hub.spriteMachines();
    assert.equal(machine?.status, "alive");
    assert.deepEqual(
      hub.calls.map(({ call, args }) => [call, args[0], args[1]]),
      [["service", `trigger-${trigger.id}`, "paseo"]],
    );
    assert.equal(hub.serviceEnvs[0]?.["LITERAL"], "rotated");
  });

  it("updates the resources policy when only the memory changes", async () => {
    const hub = await setup();
    const trigger = await hub.store.save({ yaml: spriteYaml(), userId: null });
    await hub.settled();
    await hub.enrollSprite();
    hub.calls.length = 0;

    await hub.store.save({
      triggerId: trigger.id,
      yaml: spriteYaml().replace("memory: 16384", "memory: 4096"),
      userId: null,
    });
    await hub.settled();

    const [machine] = await hub.spriteMachines();
    assert.equal(machine?.status, "alive");
    assert.deepEqual(hub.calls, [{ call: "setMemory", args: [`trigger-${trigger.id}`, 4096] }]);
    assert.equal(spriteSpecs(machine).memoryMb, 4096);
  });

  it("destroys the sprite when the trigger stops targeting one", async () => {
    const hub = await setup();
    const trigger = await hub.store.save({ yaml: spriteYaml(), userId: null });
    await hub.settled();
    await hub.enrollSprite();
    hub.calls.length = 0;

    await hub.store.save({ triggerId: trigger.id, yaml: daemonYaml, userId: null });
    await hub.settled();

    const [machine] = await hub.spriteMachines();
    assert.equal(machine?.status, "terminated");
    assert.equal(machine?.shutdownReason, "trigger no longer targets a sprite");
    assert.deepEqual(hub.calls, [{ call: "destroy", args: [`trigger-${trigger.id}`] }]);
  });

  it("destroys the sprite when the trigger is disabled", async () => {
    const hub = await setup();
    const trigger = await hub.store.save({ yaml: spriteYaml(), userId: null });
    await hub.settled();
    await hub.enrollSprite();
    hub.calls.length = 0;

    await hub.store.save({
      triggerId: trigger.id,
      yaml: spriteYaml().replace("enabled: true", "enabled: false"),
      userId: null,
    });
    await hub.settled();

    const [machine] = await hub.spriteMachines();
    assert.equal(machine?.status, "terminated");
    assert.equal(machine?.shutdownReason, "trigger no longer targets a sprite");
    assert.deepEqual(hub.calls, [{ call: "destroy", args: [`trigger-${trigger.id}`] }]);
  });

  it("refuses a disable or a target switch while executions are running on the sprite", async () => {
    const hub = await setup();
    const trigger = await hub.store.save({ yaml: spriteYaml(), userId: null });
    await hub.settled();
    await hub.enrollSprite();
    const [machine] = await hub.spriteMachines();
    await hub.startExecution(trigger.runtimeProjectId, machine!.id);
    await hub.startExecution(trigger.runtimeProjectId, machine!.id);
    hub.calls.length = 0;

    await assert.rejects(
      hub.store.save({
        triggerId: trigger.id,
        yaml: spriteYaml().replace("enabled: true", "enabled: false"),
        userId: null,
      }),
      /enabled: Disabling the trigger destroys the sprite and ends its 2 running executions\. Save again once it is idle\./u,
    );
    await assert.rejects(
      hub.store.save({ triggerId: trigger.id, yaml: daemonYaml, userId: null }),
      /run\.target\.kind: Changing the target destroys the sprite and ends its 2 running executions\. Save again once it is idle\./u,
    );
    assert.deepEqual(hub.calls, []);
    assert.equal((await hub.spriteMachines())[0]?.status, "alive");
  });

  it("leaves a sprite that is still spawning alone until it is alive", async () => {
    const hub = await setup();
    const trigger = await hub.store.save({ yaml: spriteYaml(), userId: null });
    await hub.settled();
    hub.calls.length = 0;

    await hub.store.save({
      triggerId: trigger.id,
      yaml: spriteYaml()
        .replace("memory: 16384", "memory: 4096")
        .replace("LITERAL: plain", "LITERAL: rotated"),
      userId: null,
    });
    await hub.settled();

    const [machine] = await hub.spriteMachines();
    assert.equal(machine?.status, "spawning");
    assert.equal(spriteSpecs(machine).memoryMb, 16384);
    assert.deepEqual(hub.calls, []);
  });

  it("skips the service rewrite when the sprite has no npm prefix yet", async () => {
    const hub = await setup();
    const trigger = await hub.store.save({ yaml: spriteYaml(), userId: null });
    await hub.settled();
    await hub.enrollSprite();
    const [machine] = await hub.spriteMachines();
    assert.ok(machine);
    const { npmPrefix, ...specs } = spriteSpecs(machine);
    assert.equal(npmPrefix, PREFIX);
    await hub.database.setMachineSpecs(machine.id, specs);
    hub.calls.length = 0;

    await hub.store.save({
      triggerId: trigger.id,
      yaml: spriteYaml().replace("LITERAL: plain", "LITERAL: rotated"),
      userId: null,
    });
    await hub.settled();

    assert.deepEqual(hub.calls, []);
  });

  it("recreates the sprite on the next save once the row is terminated", async () => {
    const hub = await setup();
    const trigger = await hub.store.save({ yaml: spriteYaml(), userId: null });
    await hub.settled();
    await hub.enrollSprite();
    const changed = spriteYaml().replace(
      "@anthropic-ai/claude-code",
      "@anthropic-ai/claude-code@2",
    );
    await hub.store.save({ triggerId: trigger.id, yaml: changed, userId: null });
    await hub.settled();
    hub.calls.length = 0;

    await hub.store.save({ triggerId: trigger.id, yaml: changed, userId: null });
    await hub.settled();

    const machines = await hub.spriteMachines();
    assert.equal(machines.length, 2);
    assert.equal(machines[1]?.status, "spawning");
    assert.equal(hub.calls.filter(({ call }) => call === "create").length, 1);
  });
});

const success: ExecResult = { stdout: "", stderr: "", exitCode: 0 };

async function setup(
  options: {
    configured?: boolean;
    unavailable?: boolean;
    create?: () => void;
    destroy?: () => void;
    exec?: (argv: string[]) => ExecResult;
    service?: (name: string) => void;
    orgEnv?: Record<string, string>;
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
      env: options.orgEnv ?? { ANTHROPIC_API_KEY: "org-anthropic", ORG_ONLY: "org-value" },
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
    async destroy(name) {
      calls.push({ call: "destroy", args: [name] });
      options.destroy?.();
    },
    async create(input) {
      calls.push({ call: "create", args: [input] });
      options.create?.();
      return "sprite-id";
    },
    async exec(name, argv, execOptions) {
      calls.push({ call: "exec", args: [name, argv, execOptions] });
      execArgvs.push(argv);
      if (argv[2] === "npm prefix -g") return { ...success, stdout: `${PREFIX}\n` };
      return options.exec?.(argv) ?? success;
    },
    async service(name, service, definition) {
      calls.push({ call: "service", args: [name, service, definition] });
      serviceEnvs.push(definition.env);
      options.service?.(name);
    },
    async setMemory(name, memoryMb) {
      calls.push({ call: "setMemory", args: [name, memoryMb] });
    },
  };
  const connectionsForProject = () =>
    options.resolver ?? ((slug: string, value: string) => `resolved:${slug}.${value}`);
  const providerFor = (token: string) => {
    assert.equal(token, "sprites-token");
    return provider;
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
    connectionsForProject,
    hubOrigin: "https://hub.test",
    provider: providerFor,
  });
  const jobs: Promise<void>[] = [];
  const tracked: SpriteActivation = async (input) => {
    const started = await activate(input);
    if (started !== undefined) jobs.push(started.job);
    return started;
  };
  const store = new OrganizationTriggerStore(
    database,
    "org",
    entitlements,
    options.unavailable === true ? null : tracked,
  );
  return {
    store,
    database,
    rewrite: createSpriteServiceRewrite({ database, connectionsForProject, provider: providerFor }),
    calls,
    execArgvs,
    serviceEnvs,
    keys,
    revoked,
    settled: () => Promise.all(jobs),
    spriteMachines: () => Promise.all(machineIds.map((id) => database.findMachineById(id))),
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
    async enrollSprite(apiKeyId = "key-1") {
      await database.issueEnrollmentToken({
        id: randomUUID(),
        verifier: apiKeyId,
        organizationId: "org",
        issuedByApiKeyId: apiKeyId,
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        consumedAt: null,
      });
      const daemonId = randomUUID();
      await database.enrollDaemon({
        daemonId,
        idempotencyKey: daemonId,
        tokenVerifier: apiKeyId,
        serverId: "sprite-server",
        daemonPublicKey: "public-key",
        credentialVerifier: "credential-verifier",
        permissions: ["hub.execute"],
        now: new Date("2026-09-17T00:00:00.000Z"),
      });
      return daemonId;
    },
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
