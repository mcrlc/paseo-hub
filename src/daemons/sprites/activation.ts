import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { OrganizationApiKeys } from "../../auth/api-keys.js";
import { parseCompiledHubConfig, type CompiledEnvironment } from "../../config/compiler.js";
import { resolveConnectionTemplate } from "../../config/connection-template.js";
import type { ConnectionResolver } from "../../config/connections.js";
import type { Database, MachineRecord, OrganizationTriggerRecord } from "../../db/types.js";
import { reportFailure } from "../../failures/index.js";
import { logger } from "../../logger.js";
import { createSpritesClient, type ExecResult, type SpritesClient } from "./client.js";

const HOME = "/home/sprite";
const SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const DAEMON_LISTEN = "127.0.0.1:6767";
const CONNECT_SCRIPT = `for i in $(seq 600); do
  curl -so /dev/null http://${DAEMON_LISTEN}/
  [ $? -ne 7 ] && exec paseo hub connect "$1" --host ${DAEMON_LISTEN} --api-key "$2" --permission hub.execute
  [ $((i % 30)) -eq 0 ] && echo "waiting for paseo daemon on ${DAEMON_LISTEN}: \${i}s"
  sleep 1
done
echo "paseo daemon is not listening on ${DAEMON_LISTEN}" >&2
exit 1`;

export type SpriteTarget = Extract<CompiledEnvironment, { kind: "sprite" }>;
export type SpriteProvider = Pick<
  SpritesClient,
  "create" | "exec" | "service" | "destroy" | "setMemory"
>;

const SpriteSpecsSchema = z
  .object({
    bootstrapHash: z.string(),
    envHash: z.string(),
    memoryMb: z.number(),
    npmPrefix: z.string(),
  })
  .partial()
  .catch({});

export type SpriteSpecs = z.infer<typeof SpriteSpecsSchema>;

export function spriteSpecs(machine: MachineRecord): SpriteSpecs {
  return SpriteSpecsSchema.parse(machine.specs);
}

export function bootstrapHash(bootstrap: string): string {
  return createHash("sha256").update(bootstrap).digest("hex");
}

function envHash(env: SpriteTarget["env"]): string {
  return createHash("sha256")
    .update(JSON.stringify(Object.entries(env ?? {}).sort(([a], [b]) => a.localeCompare(b))))
    .digest("hex");
}

export interface SpriteActivationOptions {
  database: Database;
  apiKeys: Pick<OrganizationApiKeys, "create" | "revoke">;
  connectionsForProject: (projectId: string) => ConnectionResolver;
  hubOrigin: string;
  provider?: (token: string) => SpriteProvider;
}

/** An undefined target means the trigger no longer runs on a sprite, so the live one is retired. */
export type SpriteActivation = (input: {
  trigger: OrganizationTriggerRecord;
  target: SpriteTarget | undefined;
  userId: string | null;
}) => Promise<{ job: Promise<void> } | undefined>;

export function createSpriteActivation(options: SpriteActivationOptions): SpriteActivation {
  const providerFor = options.provider ?? ((token) => createSpritesClient({ token }));
  return async ({ trigger, target, userId }) => {
    const { database, apiKeys } = options;
    const live = await database.findLiveSpriteMachine(trigger.id);
    if (live !== undefined) {
      try {
        await reconcileSprite({ ...options, providerFor, trigger, machine: live, target });
      } catch (error) {
        reportFailure(error, {
          operation: "sprites.reconcile",
          component: "sprites",
          organizationId: trigger.organizationId,
        });
      }
      return undefined;
    }
    if (target === undefined) return undefined;
    const configuration = await database.getOrganizationSpritesConfiguration(
      trigger.organizationId,
    );
    if (configuration === undefined) throw new Error("Sprites are not configured");
    const key = await apiKeys.create(trigger.organizationId, userId, `Sprite ${trigger.id}`, [
      "daemons:enroll",
    ]);
    const memoryMb = target.memory ?? configuration.memoryMb;
    const specs = {
      bootstrapHash: bootstrapHash(target.bootstrap),
      envHash: envHash(target.env),
      memoryMb,
    };
    const machine = await database.insertSpriteMachine({
      orgId: trigger.organizationId,
      source: {
        kind: "sprite",
        triggerId: trigger.id,
        spriteName: `trigger-${trigger.id}`,
        apiKeyId: key.summary.id,
      },
      specs,
    });
    if (machine === undefined) {
      await apiKeys.revoke(trigger.organizationId, key.summary.id);
      return undefined;
    }
    const provider = providerFor(configuration.token);
    const secrets = [key.secret, ...Object.values(configuration.env)];

    const provision = async () => {
      try {
        await provisionSprite({
          database,
          provider,
          resolver: options.connectionsForProject(trigger.runtimeProjectId),
          hubOrigin: options.hubOrigin,
          machine,
          target,
          specs,
          apiKey: key.secret,
          organizationEnv: configuration.env,
          secrets,
        });
        logger.info({ machineId: machine.id }, "sprite activation bootstrapped");
      } catch (error) {
        const reason = scrub(error instanceof Error ? error.message : String(error), secrets);
        logger.warn({ machineId: machine.id, reason }, "sprite activation failed");
        await database.transitionMachine(machine.id, "terminated", { reason });
        await apiKeys.revoke(trigger.organizationId, key.summary.id);
        if (await destroyBestEffort(provider, machine)) {
          logger.info({ machineId: machine.id }, "sprite activation: destroyed after failure");
        }
      }
    };
    const job = provision().catch((error: unknown) => {
      reportFailure(
        error,
        {
          operation: "sprites.activate",
          component: "sprites",
          organizationId: trigger.organizationId,
        },
        { scrubValues: secrets },
      );
    });
    return { job };
  };
}

async function provisionSprite(input: {
  database: Database;
  provider: SpriteProvider;
  resolver: ConnectionResolver;
  hubOrigin: string;
  machine: MachineRecord;
  target: SpriteTarget;
  specs: SpriteSpecs & { memoryMb: number };
  apiKey: string;
  organizationEnv: Record<string, string>;
  secrets: readonly string[];
}): Promise<void> {
  const { provider, machine, target } = input;
  if (machine.source.kind !== "sprite") throw new Error("machine is not a sprite");
  const name = machine.source.spriteName;
  const step = (label: string) => logger.info({ machineId: machine.id, sprite: name }, label);

  step("sprite activation: destroy leftover");
  await destroyBestEffort(provider, machine);
  step("sprite activation: create");
  await provider.create({ name, memoryMb: input.specs.memoryMb });
  step("sprite activation: npm prefix");
  const prefixResult = await provider.exec(name, ["sh", "-c", "npm prefix -g"]);
  expectSuccess("npm prefix -g", prefixResult, input.secrets);
  const npmPrefix = prefixResult.stdout.trim();
  if (npmPrefix === "") throw new Error("npm prefix -g printed nothing");
  await input.database.setMachineSpecs(machine.id, { ...input.specs, npmPrefix });
  const PATH = `${npmPrefix}/bin:${SYSTEM_PATH}`;
  step("sprite activation: install paseo");
  expectSuccess(
    "paseo install",
    await provider.exec(name, ["sh", "-c", "npm install -g @getpaseo/cli"], {
      env: { PATH },
    }),
    input.secrets,
  );
  const targetEnv = await resolveTargetEnv(target, input.resolver);
  const bootstrapEnv = { PATH, ...input.organizationEnv, ...targetEnv };
  step("sprite activation: bootstrap");
  expectSuccess(
    "bootstrap",
    await provider.exec(name, ["sh", "-s"], {
      env: bootstrapEnv,
      stdin: target.bootstrap,
    }),
    input.secrets,
  );
  const service = daemonService(npmPrefix, { ...input.organizationEnv, ...targetEnv });
  step("sprite activation: daemon service");
  await provider.service(name, "paseo", service.definition);
  // `paseo hub connect` enrolls through the running daemon, so the service must exist first.
  step("sprite activation: hub connect");
  const connected = await provider.exec(
    name,
    ["sh", "-c", CONNECT_SCRIPT, "sh", input.hubOrigin, input.apiKey],
    { env: service.daemonEnv },
  );
  logger.info(
    { machineId: machine.id, sprite: name, output: scrub(connected.stdout, input.secrets) },
    "sprite activation: hub connect output",
  );
  expectSuccess("hub connect", connected, input.secrets);
}

async function reconcileSprite(
  input: Pick<SpriteActivationOptions, "database" | "connectionsForProject"> & {
    providerFor: (token: string) => SpriteProvider;
    trigger: OrganizationTriggerRecord;
    machine: MachineRecord;
    target: SpriteTarget | undefined;
  },
): Promise<void> {
  const { database, machine, target } = input;
  if (machine.source.kind !== "sprite") return;
  const configuration = await database.getOrganizationSpritesConfiguration(machine.orgId);
  if (configuration === undefined) return;
  const provider = input.providerFor(configuration.token);
  const specs = spriteSpecs(machine);
  if (target === undefined || specs.bootstrapHash !== bootstrapHash(target.bootstrap)) {
    await retireSprite(
      database,
      provider,
      machine,
      target === undefined ? "trigger no longer targets a sprite" : "bootstrap changed",
    );
    return;
  }
  if (machine.status !== "alive") return;
  const memoryMb = target.memory ?? configuration.memoryMb;
  const nextEnvHash = envHash(target.env);
  if (memoryMb === specs.memoryMb && nextEnvHash === specs.envHash) return;
  if (memoryMb !== specs.memoryMb) await provider.setMemory(machine.source.spriteName, memoryMb);
  if (nextEnvHash !== specs.envHash) {
    await rewriteSpriteService({
      provider,
      resolver: input.connectionsForProject(input.trigger.runtimeProjectId),
      machine,
      target,
      organizationEnv: configuration.env,
      triggerId: input.trigger.id,
    });
  }
  await database.setMachineSpecs(machine.id, { ...specs, memoryMb, envHash: nextEnvHash });
}

async function retireSprite(
  database: Database,
  provider: Pick<SpriteProvider, "destroy">,
  machine: MachineRecord,
  reason: string,
): Promise<void> {
  await destroyBestEffort(provider, machine);
  const daemon = await database.findDaemonByMachineId(machine.id);
  if (daemon !== undefined) await database.revokeDaemon(daemon.id);
  await database.transitionMachine(machine.id, "terminated", { reason });
  logger.info({ machineId: machine.id, reason }, "sprite retired");
}

async function rewriteSpriteService(input: {
  provider: Pick<SpriteProvider, "service">;
  resolver: ConnectionResolver;
  machine: MachineRecord;
  target: SpriteTarget;
  organizationEnv: Record<string, string>;
  triggerId: string;
}): Promise<void> {
  const { machine } = input;
  if (machine.source.kind !== "sprite") return;
  const { npmPrefix } = spriteSpecs(machine);
  if (npmPrefix === undefined) return;
  const sprite = machine.source.spriteName;
  const targetEnv = await resolveTargetEnv(input.target, input.resolver);
  const service = daemonService(npmPrefix, { ...input.organizationEnv, ...targetEnv });
  await input.provider.service(sprite, "paseo", service.definition);
  logger.info(
    { triggerId: input.triggerId, sprite, envKeys: Object.keys(service.definition.env).length },
    "sprite service rewritten",
  );
}

export function createSpriteServiceRewrite(
  options: Pick<SpriteActivationOptions, "database" | "connectionsForProject" | "provider">,
): (organizationId: string) => Promise<void> {
  const providerFor = options.provider ?? ((token) => createSpritesClient({ token }));
  return async (organizationId) => {
    const { database } = options;
    const context = { operation: "sprites.rewrite-service", component: "sprites", organizationId };
    let secrets: string[] = [];
    try {
      const configuration = await database.getOrganizationSpritesConfiguration(organizationId);
      if (configuration === undefined) return;
      secrets = Object.values(configuration.env);
      const provider = providerFor(configuration.token);
      for (const trigger of await database.listOrganizationTriggers(organizationId)) {
        const machine = await database.findLiveSpriteMachine(trigger.id);
        if (machine?.status !== "alive" || machine.source.kind !== "sprite") continue;
        const sprite = machine.source.spriteName;
        try {
          const revision = await database.findActiveProjectConfiguration(trigger.runtimeProjectId);
          const target = parseCompiledHubConfig(
            revision?.normalizedConfiguration,
          ).environments.find(
            (environment): environment is SpriteTarget => environment.kind === "sprite",
          );
          if (target === undefined) continue;
          await rewriteSpriteService({
            provider,
            resolver: options.connectionsForProject(trigger.runtimeProjectId),
            machine,
            target,
            organizationEnv: configuration.env,
            triggerId: trigger.id,
          });
        } catch (error) {
          reportFailure(
            error,
            { ...context, triggerId: trigger.id, sprite },
            {
              scrubValues: secrets,
            },
          );
        }
      }
    } catch (error) {
      reportFailure(error, context, { scrubValues: secrets });
    }
  };
}

async function resolveTargetEnv(
  target: SpriteTarget,
  resolver: ConnectionResolver,
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const [key, template] of Object.entries(target.env ?? {})) {
    env[key] = await resolveConnectionTemplate(
      template,
      resolver,
      {
        registerToken: () => {
          throw new Error(`env.${key} cannot be resolved without an execution lease`);
        },
      },
      `env.${key}`,
    );
  }
  return env;
}

function daemonService(npmPrefix: string, env: Record<string, string>) {
  const daemonEnv = {
    HOME,
    PASEO_HOME: `${HOME}/.paseo`,
    PATH: `${npmPrefix}/bin:${SYSTEM_PATH}`,
    PASEO_PASSWORD: randomBytes(32).toString("base64url"),
  };
  return {
    daemonEnv,
    definition: {
      cmd: `${npmPrefix}/bin/paseo`,
      args: ["start", "--foreground", "--listen", DAEMON_LISTEN, "--no-relay", "--no-web-ui"],
      env: { ...daemonEnv, ...env },
      dir: HOME,
    },
  };
}

async function destroyBestEffort(
  provider: Pick<SpriteProvider, "destroy">,
  machine: MachineRecord,
): Promise<boolean> {
  if (machine.source.kind !== "sprite") return false;
  try {
    await provider.destroy(machine.source.spriteName);
    return true;
  } catch (error) {
    reportFailure(error, {
      operation: "sprites.destroy",
      component: "sprites",
      organizationId: machine.orgId,
    });
    return false;
  }
}

function expectSuccess(label: string, result: ExecResult, secrets: readonly string[]): void {
  if (result.exitCode === 0) return;
  const output = scrub(`${result.stdout}${result.stderr}`, secrets).trim().slice(-2000);
  throw new Error(`${label} exited with ${String(result.exitCode)}: ${output}`);
}

/** Short values match too much of a log line to replace, and are not credentials. */
const SECRET_MIN_LENGTH = 8;

function scrub(text: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (scrubbed, secret) =>
      secret.length < SECRET_MIN_LENGTH ? scrubbed : scrubbed.replaceAll(secret, "[redacted]"),
    text,
  );
}
