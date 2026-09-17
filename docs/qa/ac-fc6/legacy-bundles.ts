/* QA evidence scripts: they print to stdout and inspect arbitrary thrown values. */
/* oxlint-disable */
// Usage: npx tsx docs/qa/ac-fc6/legacy-bundles.ts
// A: compileHubBundle directly. B: POST /api/v1/configurations/install through createPublicApi wired to the
// real public operations, ProjectConfigurationStore, and the in-memory database (same composition as
// src/public-operations/install-configuration.test.ts), with a stub authenticator.
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

const organizationId = "organization-1";

function bundle(kind: "fly" | "docker"): HubBundleFile[] {
  return [
    {
      path: ".paseo/hub.yml",
      content: [
        "environments:",
        "  runner:",
        `    kind: ${kind}`,
        "    image: paseo/test",
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
}

console.log("== A. compileHubBundle ==");
for (const kind of ["fly", "docker"] as const) {
  try {
    compileHubBundle(bundle(kind));
    console.log(`${kind}: ACCEPTED (unexpected)`);
  } catch (error) {
    const issues = (error as { issues?: unknown }).issues;
    console.log(`${kind}: ${(error as Error).constructor.name}: ${(error as Error).message}`);
    if (issues !== undefined) console.log(`${kind}: issues=${JSON.stringify(issues)}`);
  }
}

console.log("\n== B. POST /api/v1/configurations/install ==");
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
for (const kind of ["fly", "docker"] as const) {
  const body = JSON.stringify({ projectSlug: project.slug, files: bundle(kind) });
  const request = new Request("https://hub.test/api/v1/configurations/install", {
    method: "POST",
    headers: {
      authorization: "Bearer valid",
      "content-type": "application/json",
      "x-request-id": `qa-${kind}`,
    },
    body,
  });
  console.log(`--> POST ${new URL(request.url).pathname} (${kind})`);
  console.log(JSON.stringify(JSON.parse(body), null, 2));
  const response = await api.handle(request);
  console.log(`<-- HTTP ${response.status} ${response.headers.get("content-type")}`);
  console.log(JSON.stringify(await response.json(), null, 2));
  console.log(
    response.status >= 400 && response.status < 500
      ? `${kind}: RESULT pass (4xx)`
      : `${kind}: RESULT fail`,
  );
}
