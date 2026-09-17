/* oxlint-disable */
// Usage: npx tsx docs/qa/ac-vni/s3-enrollment-binding.ts
// Scenario 3 (database level, complements the two harness tests): enrollment through a token issued by the
// sprite's key binds to the pre-created row, revokes the key, and expires the key's other unconsumed tokens;
// a token issued by an unrelated key inserts a fresh daemon-kind machine and leaves the sprite row spawning.
import { randomUUID } from "node:crypto";
import { OrganizationApiKeys } from "../../../src/auth/api-keys.js";
import { apiKeyRows, openPostgres, seedOrganization, type Pg } from "./pg-common.js";

const pg = await openPostgres();
const org = await seedOrganization(pg);
const apiKeys = new OrganizationApiKeys(pg.runtime, pg.locks);

async function token(apiKeyId: string) {
  const verifier = `verifier-${randomUUID()}`;
  await pg.database.issueEnrollmentToken({
    id: randomUUID(),
    verifier,
    organizationId: org.organizationId,
    issuedByApiKeyId: apiKeyId,
    expiresAt: new Date(Date.now() + 600_000),
    consumedAt: null,
  });
  return verifier;
}

async function enroll(verifier: string, slug: string) {
  const daemonId = randomUUID();
  const result = await pg.database.enrollDaemon({
    daemonId,
    idempotencyKey: randomUUID(),
    suggestedSlug: slug,
    tokenVerifier: verifier,
    serverId: randomUUID(),
    daemonPublicKey: "public",
    credentialVerifier: "credential",
    permissions: ["hub.execute"],
    now: new Date(),
  });
  console.log(
    `enrollDaemon(${slug}) -> ${JSON.stringify({ status: (result as { status?: string }).status })}`,
  );
  return daemonId;
}

async function show(pgc: Pg, label: string) {
  const machines = await pgc.runtime.query(
    `select id, status, source->>'kind' as kind, source->>'apiKeyId' as api_key_id from machines where org_id = $1 order by started_at`,
    [org.organizationId],
  );
  const daemons = await pgc.runtime.query(
    `select id, slug, machine_id, scopes, registered_by_api_key_id from daemons where organization_id = $1 order by created_at`,
    [org.organizationId],
  );
  const tokens = await pgc.runtime.query(
    `select issued_by_api_key_id, consumed_at is not null as consumed, expires_at <= now() as expired from daemon_enrollment_tokens where organization_id = $1`,
    [org.organizationId],
  );
  console.log(`-- ${label}`);
  console.log("machines", JSON.stringify(machines.rows, null, 1));
  console.log("daemons", JSON.stringify(daemons.rows, null, 1));
  console.log("enrollment tokens", JSON.stringify(tokens.rows, null, 1));
  console.log("api keys", JSON.stringify(await apiKeyRows(pgc, org.organizationId), null, 1));
}

const spriteKey = await apiKeys.create(org.organizationId, null, "Sprite qa", ["daemons:enroll"]);
const otherKey = await apiKeys.create(org.organizationId, null, "Laptop", ["daemons:enroll"]);
const sprite = await pg.database.insertSpriteMachine({
  orgId: org.organizationId,
  source: {
    kind: "sprite",
    triggerId: randomUUID(),
    spriteName: "trigger-qa",
    apiKeyId: spriteKey.summary.id,
  },
  specs: { memoryMb: 8192 },
});
console.log(
  `sprite machine ${sprite!.id} key ${spriteKey.summary.id}; unrelated key ${otherKey.summary.id}`,
);

const spriteToken = await token(spriteKey.summary.id);
await token(spriteKey.summary.id); // a second, unconsumed token from the same key
const otherToken = await token(otherKey.summary.id);

await show(pg, "before");
await enroll(otherToken, "laptop");
await show(pg, "after unrelated-key enrollment");
await enroll(spriteToken, "sprite-host");
await show(pg, "after sprite-key enrollment");
await pg.runtime.close();
