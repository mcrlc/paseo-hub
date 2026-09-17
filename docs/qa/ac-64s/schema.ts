/* oxlint-disable */
// Usage: npx tsx docs/qa/ac-64s/schema.ts
// Scenario 1 (full sprite document) and scenario 2 (each rejection, incl. legacy bundle compiler + install API).
import { compileTriggerDocument } from "../../../src/triggers/configuration/index.js";
import { compileHubBundle, type HubBundleFile } from "../../../src/config/bundle.js";
import {
  ProjectConfigurationStore,
  validateHubBundleForOrganization,
} from "../../../src/configuration/store.js";
import { createMemoryDatabase } from "../../../src/db/memory.js";
import { createPublicApi } from "../../../src/public-api/index.js";
import { createDatabasePublicOperationRepository } from "../../../src/public-operations/database-adapter.js";
import { createPublicOperations } from "../../../src/public-operations/index.js";
import { enrollTestDaemon } from "../../../src/test-utils/project-configuration.js";
import { SPRITE_TARGET, spriteYaml } from "./fixtures.js";

const mode = process.argv[2] ?? "all";

if (mode === "all" || mode === "accept") {
  console.log("== Scenario 1: full sprite document ==");
  const yaml = spriteYaml();
  console.log(yaml);
  const compiled = compileTriggerDocument(yaml);
  console.log("compiled.environment =", JSON.stringify(compiled.environment, null, 2));
  console.log("authored.run.auto_archive =", compiled.authored.run.auto_archive);
  console.log(
    "events[0].steps[0].autoArchive =",
    JSON.stringify((compiled.events[0]!.steps[0] as any).autoArchive),
  );
  console.log("events[0].steps[0] =", JSON.stringify(compiled.events[0]!.steps[0], null, 2));
}

if (mode === "all" || mode === "reject") {
  console.log("\n== Scenario 2a: trigger-document rejections ==");
  const cases: [string, string][] = [
    ["auto_archive: false", spriteYaml(undefined, SPRITE_TARGET, "  auto_archive: false\n")],
    [
      "missing bootstrap",
      spriteYaml(undefined, SPRITE_TARGET.replace(/    bootstrap: \|\n(      .*\n)+/u, "")),
    ],
    [
      "empty bootstrap",
      spriteYaml(
        undefined,
        SPRITE_TARGET.replace(/    bootstrap: \|\n(      .*\n)+/u, '    bootstrap: ""\n'),
      ),
    ],
    [
      "relative cwd",
      spriteYaml(
        undefined,
        SPRITE_TARGET.replace("cwd: /home/sprite/workspace/project", "cwd: workspace/project"),
      ),
    ],
    ["memory: 0", spriteYaml(undefined, SPRITE_TARGET.replace("memory: 16384", "memory: 0"))],
    ["memory: 1.5", spriteYaml(undefined, SPRITE_TARGET.replace("memory: 16384", "memory: 1.5"))],
    [
      "unknown extra field",
      spriteYaml(
        undefined,
        SPRITE_TARGET.replace("    memory: 16384\n", "    memory: 16384\n    region: iad\n"),
      ),
    ],
    [
      "env non-string value",
      spriteYaml(
        undefined,
        SPRITE_TARGET.replace("ANTHROPIC_API_KEY: plain-value", "ANTHROPIC_API_KEY: 42"),
      ),
    ],
  ];
  for (const [label, yaml] of cases) {
    try {
      compileTriggerDocument(yaml);
      console.log(`[${label}] ACCEPTED (unexpected)`);
    } catch (error) {
      const issues = (error as { issues?: { path: unknown[]; message: string }[] }).issues;
      console.log(`[${label}] ${(error as Error).name}`);
      for (const issue of issues ?? [])
        console.log(`    path=${issue.path.join(".")}  message=${issue.message}`);
    }
  }

  console.log("\n== Scenario 2b: kind: sprite in a legacy .paseo/hub.yml bundle ==");
  const bundle: HubBundleFile[] = [
    {
      path: ".paseo/hub.yml",
      content: [
        "environments:",
        "  runner:",
        "    kind: sprite",
        "    bootstrap: npm install -g @getpaseo/cli",
        "    cwd: /home/sprite/workspace",
        "agents: {}",
      ].join("\n"),
    },
    {
      path: ".paseo/workflows/request.yml",
      content: [
        "name: request",
        "on: manual.run",
        "max_runtime: 1h",
        "steps:",
        "  - id: work",
        "    environment: runner",
        "    max_runtime: 10m",
        "    idle_timeout: 1m",
        "    agent: { provider: test }",
        "    prompt: [{ text: Do it. }]",
      ].join("\n"),
    },
  ];
  try {
    compileHubBundle(bundle);
    console.log("compileHubBundle: ACCEPTED (unexpected)");
  } catch (error) {
    console.log(`compileHubBundle: ${(error as Error).name}: ${(error as Error).message}`);
    const issues = (error as { issues?: unknown }).issues;
    if (issues !== undefined) console.log(`  issues=${JSON.stringify(issues)}`);
  }

  const organizationId = "organization-1";
  const database = createMemoryDatabase({ organizationIds: [organizationId] });
  await enrollTestDaemon(database, organizationId);
  const project = await database.createProject({
    organizationId,
    name: "Payments",
    slug: "payments",
    createdByUserId: "user-1",
  });
  const store = new ProjectConfigurationStore(database, project.id);
  const operations = createPublicOperations(createDatabasePublicOperationRepository(database), {
    configurationForProject: () => ({
      validateBundle: (files) => store.validateBundle(files),
      insertManualBundleRevision: (input) => store.insertManualBundleRevision(input),
      activate: (id) => store.activate(id),
    }),
    validateBundleForOrganization: (id, files) =>
      validateHubBundleForOrganization(database, id, files),
    dispatchManualEvent: () => Promise.resolve(),
  });
  const api = createPublicApi(
    {
      status: "enabled",
      authenticator: {
        authorize: (_request, scope) =>
          Promise.resolve({
            status: "authorized",
            access: { kind: "apiKey", credentialId: "key-1", organizationId, scopes: [scope] },
          }),
      },
    },
    operations,
  );
  const response = await api.handle(
    new Request("https://hub.test/api/v1/configurations/install", {
      method: "POST",
      headers: { authorization: "Bearer valid", "content-type": "application/json" },
      body: JSON.stringify({ projectSlug: project.slug, files: bundle }),
    }),
  );
  console.log(`POST /api/v1/configurations/install -> HTTP ${response.status}`);
  console.log(JSON.stringify(await response.json(), null, 2));
  console.log(
    response.status >= 400 && response.status < 500 ? "RESULT pass (4xx)" : "RESULT fail",
  );
}

if (mode === "all" || mode === "probe") {
  console.log("\n== Probe: env template values are not validated at authoring time ==");
  for (const value of ["${{ paseo.bogus.path }}", "${{ unterminated"]) {
    const target = SPRITE_TARGET.replace(
      "${{ paseo.connections.github.token }}",
      JSON.stringify(value),
    );
    try {
      compileTriggerDocument(spriteYaml(undefined, target));
      console.log(`env GITHUB_TOKEN=${value}: ACCEPTED`);
    } catch (error) {
      console.log(`env GITHUB_TOKEN=${value}: REJECTED ${(error as Error).message}`);
    }
  }
  try {
    compileTriggerDocument(
      spriteYaml(
        undefined,
        SPRITE_TARGET.replace("newBranch: hub-work", "newBranch: ${{ paseo.bogus.path }}"),
      ),
    );
    console.log("worktree.newBranch=${{ paseo.bogus.path }}: ACCEPTED");
  } catch (error) {
    console.log(
      `worktree.newBranch=\${{ paseo.bogus.path }}: REJECTED ${(error as Error).message}`,
    );
  }
}
