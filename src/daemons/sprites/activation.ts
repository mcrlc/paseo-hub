import { createHash, randomBytes } from "node:crypto";
import type { OrganizationApiKeys } from "../../auth/api-keys.js";
import type { CompiledEnvironment } from "../../config/compiler.js";
import { resolveConnectionTemplate } from "../../config/connection-template.js";
import type { ConnectionResolver } from "../../config/connections.js";
import type { Database, MachineRecord, OrganizationTriggerRecord } from "../../db/types.js";
import { reportFailure } from "../../failures/index.js";
import { logger } from "../../logger.js";
import { createSpritesClient, type ExecResult, type SpritesClient } from "./client.js";

const NPM_PREFIX = "/.sprite/languages/node/nvm/versions/node/v24.18.0";
const HOME = "/home/sprite";
const PATH = `${NPM_PREFIX}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
const DAEMON_LISTEN = "127.0.0.1:6767";
const CONNECT_SCRIPT = `for _ in $(seq 60); do
  curl -so /dev/null http://${DAEMON_LISTEN}/
  [ $? -ne 7 ] && exec paseo hub connect "$1" --host ${DAEMON_LISTEN} --api-key "$2" --permission hub.execute
  sleep 1
done
echo "paseo daemon is not listening on ${DAEMON_LISTEN}" >&2
exit 1`;

export type SpriteTarget = Extract<CompiledEnvironment, { kind: "sprite" }>;
export type SpriteProvider = Pick<SpritesClient, "create" | "exec" | "service">;

export interface SpriteActivationOptions {
  database: Database;
  apiKeys: Pick<OrganizationApiKeys, "create" | "revoke">;
  connectionsForProject: (projectId: string) => ConnectionResolver;
  hubOrigin: string;
  provider?: (token: string) => SpriteProvider;
}

export type SpriteActivation = (input: {
  trigger: OrganizationTriggerRecord;
  target: SpriteTarget;
  userId: string | null;
}) => Promise<{ job: Promise<void> } | undefined>;

export function createSpriteActivation(options: SpriteActivationOptions): SpriteActivation {
  const providerFor = options.provider ?? ((token) => createSpritesClient({ token }));
  return async ({ trigger, target, userId }) => {
    const { database, apiKeys } = options;
    if ((await database.findLiveSpriteMachine(trigger.id)) !== undefined) return undefined;
    const configuration = await database.getOrganizationSpritesConfiguration(
      trigger.organizationId,
    );
    if (configuration === undefined) throw new Error("Sprites are not configured");
    const key = await apiKeys.create(trigger.organizationId, userId, `Sprite ${trigger.id}`, [
      "daemons:enroll",
    ]);
    const memoryMb = target.memory ?? configuration.memoryMb;
    const machine = await database.insertSpriteMachine({
      orgId: trigger.organizationId,
      source: {
        kind: "sprite",
        triggerId: trigger.id,
        spriteName: `trigger-${trigger.id}`,
        apiKeyId: key.summary.id,
      },
      specs: {
        bootstrapHash: createHash("sha256").update(target.bootstrap).digest("hex"),
        memoryMb,
      },
    });
    if (machine === undefined) {
      await apiKeys.revoke(trigger.organizationId, key.summary.id);
      return undefined;
    }
    const provision = async () => {
      try {
        await provisionSprite({
          provider: providerFor(configuration.token),
          resolver: options.connectionsForProject(trigger.runtimeProjectId),
          hubOrigin: options.hubOrigin,
          machine,
          target,
          memoryMb,
          apiKey: key.secret,
        });
        logger.info({ machineId: machine.id }, "sprite activation bootstrapped");
      } catch (error) {
        const reason = (error instanceof Error ? error.message : String(error)).replaceAll(
          key.secret,
          "[redacted]",
        );
        logger.warn({ machineId: machine.id, reason }, "sprite activation failed");
        await database.transitionMachine(machine.id, "terminated", { reason });
        await apiKeys.revoke(trigger.organizationId, key.summary.id);
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
        { scrubValues: [key.secret] },
      );
    });
    return { job };
  };
}

async function provisionSprite(input: {
  provider: SpriteProvider;
  resolver: ConnectionResolver;
  hubOrigin: string;
  machine: MachineRecord;
  target: SpriteTarget;
  memoryMb: number;
  apiKey: string;
}): Promise<void> {
  const { provider, machine, target } = input;
  if (machine.source.kind !== "sprite") throw new Error("machine is not a sprite");
  const name = machine.source.spriteName;
  const step = (label: string) => logger.info({ machineId: machine.id, sprite: name }, label);

  step("sprite activation: create");
  await provider.create({ name, memoryMb: input.memoryMb });
  step("sprite activation: install paseo");
  expectSuccess(
    "paseo install",
    await provider.exec(name, ["sh", "-c", "npm install -g @getpaseo/cli"], {
      env: { PATH },
    }),
  );
  step("sprite activation: bootstrap");
  expectSuccess(
    "bootstrap",
    await provider.exec(name, ["sh", "-s"], {
      env: { PATH },
      stdin: target.bootstrap,
    }),
  );
  const daemonEnv = {
    HOME,
    PASEO_HOME: `${HOME}/.paseo`,
    PATH,
    PASEO_PASSWORD: randomBytes(32).toString("base64url"),
  };
  const env: Record<string, string> = { ...daemonEnv };
  for (const [key, template] of Object.entries(target.env ?? {})) {
    env[key] = await resolveConnectionTemplate(
      template,
      input.resolver,
      {
        registerToken: () => {
          throw new Error(`env.${key} cannot be resolved without an execution lease`);
        },
      },
      `env.${key}`,
    );
  }
  step("sprite activation: daemon service");
  await provider.service(name, "paseo", {
    cmd: `${NPM_PREFIX}/bin/paseo`,
    args: ["start", "--foreground", "--listen", DAEMON_LISTEN, "--no-relay", "--no-web-ui"],
    env,
    dir: HOME,
  });
  // `paseo hub connect` enrolls through the running daemon, so the service must exist first.
  step("sprite activation: hub connect");
  expectSuccess(
    "hub connect",
    await provider.exec(name, ["sh", "-c", CONNECT_SCRIPT, "sh", input.hubOrigin, input.apiKey], {
      env: daemonEnv,
    }),
  );
}

function expectSuccess(label: string, result: ExecResult): void {
  if (result.exitCode === 0) return;
  const output = `${result.stdout}${result.stderr}`.trim().slice(-2000);
  throw new Error(`${label} exited with ${String(result.exitCode)}: ${output}`);
}
