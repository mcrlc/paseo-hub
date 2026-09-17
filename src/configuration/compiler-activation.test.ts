import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { dump } from "js-yaml";
import { createMemoryDatabase } from "../db/memory.js";
import { parseProjectConfiguration, ProjectConfigurationStore } from "./store.js";
import { configurationBundleFixture } from "../test-utils/configuration-bundle.js";

describe("compiled workflow activation", () => {
  it("activates a valid step-based configuration and stores the compiled contract", async () => {
    const database = createMemoryDatabase();
    await enrollTestDaemon(database);
    const project = await database.createProject({
      organizationId: "org_1",
      name: "compiler-project",
      slug: "compiler-project",
      createdByUserId: "user-1",
    });
    const store = new ProjectConfigurationStore(database, project.id);
    const revision = await store.insertManualBundleRevision({
      files: configurationBundleFixture(
        dump({
          environments: [
            { name: "runner", kind: "daemon", daemon: "daemon-runner-0", cwd: "/repo" },
          ],
          triggers: [
            {
              name: "manual-workflow",
              on: "manual.run",
              max_runtime: "1h",
              steps: [
                {
                  id: "work",
                  environment: "runner",
                  max_runtime: "10m",
                  idle_timeout: "1m",
                  agent: { provider: "codex" },
                  prompt: [{ text: "Run the requested work" }],
                },
              ],
            },
          ],
        }),
      ),
      userId: "user-1",
    });

    assert.equal(revision.validationErrors, null);
    const compiled = parseProjectConfiguration(revision);
    assert.equal(compiled.triggers[0]?.maxRuntimeMs, 3_600_000);
    assert.equal("max_runtime" in compiled.triggers[0], false);

    const active = await store.activate(revision.id);
    assert.equal(active.configuration.triggers[0]?.steps[0]?.maxRuntimeMs, 600_000);
    assert.equal(Object.isFrozen(active.configuration.triggers[0]?.steps[0]), true);

    await assert.rejects(
      store.insertManualBundleRevision({
        files: configurationBundleFixture(
          dump({
            environments: [
              { name: "runner", kind: "daemon", daemon: "daemon-runner-0", cwd: "/repo" },
            ],
            triggers: [
              {
                name: "legacy",
                on: "manual.run",
                max_runtime: "1h",
                environment: "runner",
                agent: { provider: "codex" },
                prompt: [{ text: "legacy" }],
                steps: [],
              },
            ],
          }),
        ),
        userId: "user-1",
      }),
      /environment.*step|unknown/iu,
    );
    assert.equal((await store.getActive())?.revision.id, revision.id);
  });
});
async function enrollTestDaemon(database: ReturnType<typeof createMemoryDatabase>): Promise<void> {
  await database.issueEnrollmentToken({
    id: "token-1",
    verifier: "token-verifier",
    organizationId: "org_1",
    expiresAt: new Date("2026-08-06T12:00:00.000Z"),
    consumedAt: null,
  });
  await database.enrollDaemon({
    tokenVerifier: "token-verifier",
    daemonId: "runner-00000000",
    idempotencyKey: "runner-idempotency",
    serverId: "server-1",
    daemonPublicKey: "public-key",
    credentialVerifier: "credential-verifier",
    permissions: ["hub.execute"],
    now: new Date("2026-08-06T11:00:00.000Z"),
  });
}
