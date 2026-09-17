/* oxlint-disable */
// Usage: npx tsx docs/qa/ac-vni/s1-call-sequence.ts
// Scenario 1: createSpriteActivation through OrganizationTriggerStore.save on Postgres with real
// OrganizationApiKeys and a provider stub that records every call. Secrets are replaced before printing.
import type { SpriteProvider } from "../../../src/daemons/sprites/activation.js";
import type { ExecResult } from "../../../src/daemons/sprites/client.js";
import {
  activationStore,
  apiKeyRows,
  openPostgres,
  seedOrganization,
  spriteMachines,
  spriteYaml,
} from "./pg-common.js";

const PREFIX = "/.sprite/languages/node/nvm/versions/node/v24.18.0";
const ok: ExecResult = { stdout: "", stderr: "", exitCode: 0 };

function recorder(onExec: (argv: string[]) => ExecResult = () => ok) {
  const calls: Array<{ call: string; args: unknown[] }> = [];
  const provider: SpriteProvider = {
    async create(input) {
      calls.push({ call: "create", args: [input] });
      return "sprite-id";
    },
    async exec(name, argv, options) {
      calls.push({ call: "exec", args: [name, argv, options] });
      if (argv[2] === "npm prefix -g") return { ...ok, stdout: `${PREFIX}\n` };
      return onExec(argv);
    },
    async service(name, service, definition) {
      calls.push({ call: "service", args: [name, service, definition] });
    },
    async destroy(name) {
      calls.push({ call: "destroy", args: [name] });
    },
  };
  return { calls, provider };
}

const pg = await openPostgres();
const redact = (value: unknown, secrets: string[]) => {
  let text = JSON.stringify(value, null, 2);
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, "[redacted]");
  return text;
};

// --- happy path
{
  console.log("=== 1a happy path ===");
  const org = await seedOrganization(pg);
  const { calls, provider } = recorder();
  const { store, settled } = activationStore(pg, org, provider);
  const trigger = await store.save({
    yaml: spriteYaml({
      env: "LITERAL: plain\nANTHROPIC_API_KEY: ${{ paseo.connections.anthropic.api_key }}",
    }),
    userId: null,
  });
  await settled();
  const service = calls.find((c) => c.call === "service")!.args[2] as {
    env: Record<string, string>;
  };
  const password = service.env.PASEO_PASSWORD!;
  const connect = calls.at(-1)!.args[1] as string[];
  const apiKey = connect[5]!;
  console.log(`trigger ${trigger.id}`);
  console.log(`PASEO_PASSWORD non-empty: ${password.length > 0} (length ${password.length})`);
  console.log(`api key passed to connect starts with paseo_pk_: ${apiKey.startsWith("paseo_pk_")}`);
  console.log("ordered provider calls:");
  console.log(redact(calls, [password, apiKey]));
  console.log("machines:", redact(await spriteMachines(pg, trigger.id), []));
  console.log("api keys:", redact(await apiKeyRows(pg, org.organizationId), []));

  console.log("\n=== 1d second activation (save unchanged and with a prompt edit) ===");
  const before = calls.length;
  await store.save({
    triggerId: trigger.id,
    yaml: (await store.activeRevision(trigger)).yaml,
    userId: null,
  });
  await store.save({
    triggerId: trigger.id,
    yaml: spriteYaml({
      prompt: "Call the finish_execution MCP tool exactly once. Edited.",
      env: "LITERAL: plain\nANTHROPIC_API_KEY: ${{ paseo.connections.anthropic.api_key }}",
    }),
    userId: null,
  });
  await settled();
  console.log(`provider calls after two more saves: ${calls.length - before}`);
  console.log(`machine rows: ${(await spriteMachines(pg, trigger.id)).length}`);
  console.log(`api keys: ${(await apiKeyRows(pg, org.organizationId)).length}`);
}

// --- bootstrap exits 3
{
  console.log("\n=== 1b bootstrap exit 3 ===");
  const org = await seedOrganization(pg);
  const { calls, provider } = recorder((argv) =>
    argv[1] === "-s" ? { stdout: "partial\n", stderr: "bad\n", exitCode: 3 } : ok,
  );
  const { store, settled } = activationStore(pg, org, provider);
  const trigger = await store.save({
    yaml: spriteYaml({ bootstrap: "echo bad >&2; exit 3" }),
    userId: null,
  });
  await settled();
  console.log("call names:", JSON.stringify(calls.map((c) => c.call)));
  console.log("last call argv:", JSON.stringify(calls.at(-1)!.args[1] as string[]));
  console.log("machines:", redact(await spriteMachines(pg, trigger.id), []));
  console.log("api keys:", redact(await apiKeyRows(pg, org.organizationId), []));
}

// --- leased connection template
{
  console.log("\n=== 1c env template that needs a lease ===");
  const org = await seedOrganization(pg);
  const { calls, provider } = recorder();
  const { store, settled } = activationStore(pg, org, provider, async (slug, value, context) => {
    // What the real GitHub resolver does for `.token`: register the minted token against the execution lease.
    await context?.registerToken?.({
      provider: "github",
      token: "ghs_fake",
      expiresAt: Date.now() + 60_000,
    });
    return "ghs_fake";
  });
  const trigger = await store.save({
    yaml: spriteYaml({ env: "GITHUB_TOKEN: ${{ paseo.connections.github.token }}" }),
    userId: null,
  });
  await settled();
  console.log("call names:", JSON.stringify(calls.map((c) => c.call)));
  console.log("machines:", redact(await spriteMachines(pg, trigger.id), []));
  console.log("api keys:", redact(await apiKeyRows(pg, org.organizationId), []));
}

await pg.runtime.close();
