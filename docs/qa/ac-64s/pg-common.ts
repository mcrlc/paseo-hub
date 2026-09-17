/* oxlint-disable */
// Shared Postgres setup for the ac-64s scripts. Expects a Postgres at QA_PG (default below), e.g.
//   docker run -d --rm --name qa-ac64s-pg -e POSTGRES_PASSWORD=qa -e POSTGRES_USER=qa -e POSTGRES_DB=qa -p 55433:5432 postgres:17-alpine
import { randomUUID } from "node:crypto";
import { createPostgresTestRuntime } from "../../../src/db/test-utils/runtime.js";

export const QA_PG = process.env.QA_PG ?? "postgres://qa:qa@127.0.0.1:55433/qa";

export async function openPostgres() {
  const composed = await createPostgresTestRuntime(QA_PG);
  return composed;
}

export async function seedOrganization(
  composed: Awaited<ReturnType<typeof openPostgres>>,
  withDaemon = true,
) {
  const organizationId = `org-${randomUUID()}`;
  const slug = `qa-${organizationId.slice(4, 12)}`;
  await composed.runtime.query("insert into organization (id, name, slug) values ($1, $2, $3)", [
    organizationId,
    "QA ac-64s",
    slug,
  ]);
  let daemonId: string | undefined;
  if (withDaemon) {
    const verifier = `token-${randomUUID()}`;
    await composed.database.issueEnrollmentToken({
      id: randomUUID(),
      verifier,
      organizationId,
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
    });
    daemonId = randomUUID();
    await composed.database.enrollDaemon({
      daemonId,
      idempotencyKey: randomUUID(),
      suggestedSlug: "devbox",
      tokenVerifier: verifier,
      serverId: randomUUID(),
      daemonPublicKey: "public",
      credentialVerifier: "credential",
      permissions: ["hub.execute"],
      now: new Date(),
    });
  }
  return { organizationId, slug, daemonId };
}
