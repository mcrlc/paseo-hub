/* oxlint-disable */
// Usage: npx tsx docs/qa/ac-7vf/s4-fallback-probe.ts
// Scenario 4: the sentence the recreate handler hands the browser for each failure. The busy
// refusal is matched by `name`, so it is probed both as the real class and as the plain Error
// the class decays to across the server-function chunk boundary.
import { SpriteBusyError } from "../../../src/triggers/dashboard.js";
import { recreateSpriteMessage } from "../../../src/triggers/functions.js";

const decayed = (name: string, message: string) => Object.assign(new Error(message), { name });

const cases: Array<[string, unknown]> = [
  [
    "postgres: relation does not exist",
    Object.assign(new Error('relation "machines" does not exist'), { code: "42P01" }),
  ],
  ["provider: sprites API rejected the token", new Error("sprites api 401: invalid token")],
  ["network: ECONNREFUSED", new Error("connect ECONNREFUSED 127.0.0.1:1")],
  ["a thrown string", "something went wrong"],
  ["SpriteBusyError(1), same chunk", new SpriteBusyError(1)],
  ["SpriteBusyError(3), same chunk", new SpriteBusyError(3)],
  [
    "SpriteBusyError across the chunk boundary",
    decayed("SpriteBusyError", new SpriteBusyError(2).message),
  ],
  [
    "an unrelated error that happens to be named",
    decayed("DatabaseError", "connection terminated"),
  ],
];

for (const [label, error] of cases) {
  console.log(`${label}\n  -> ${JSON.stringify(recreateSpriteMessage(error))}`);
}
process.exit(0);
