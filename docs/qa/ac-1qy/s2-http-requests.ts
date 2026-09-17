// Scenario 2: record the exact request each client call sends, with canned provider responses.
import { createSpritesClient, SpritesError } from "../../../src/daemons/sprites/client.js";

const log = (line: string) => process.stdout.write(`${line}\n`);

type Responder = (method: string, url: string) => Response;
const frames = (exit: number, stdout = "", stderr = "") =>
  new Response(
    new Uint8Array([1, ...Buffer.from(stdout), 2, ...Buffer.from(stderr), 3, exit, 0x0a]),
  );

function recorder(respond: Responder) {
  const fetchStub: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = typeof init?.body === "string" ? init.body : "<none>";
    const q = new URL(url).searchParams;
    log(`  ${method} ${url}`);
    log(`    headers: ${JSON.stringify(headers)}`);
    log(`    body: ${body}`);
    if (q.size)
      log(
        `    query: cmd=${JSON.stringify(q.getAll("cmd"))} env=${JSON.stringify(q.getAll("env"))} dir=${q.get("dir")} stdin=${q.get("stdin")}`,
      );
    const response = respond(method, url);
    log(`    <- canned ${response.status}`);
    return response;
  };
  return createSpritesClient({ token: "tok_TEST", fetch: fetchStub });
}

async function block(title: string, run: () => Promise<unknown>) {
  log(`\n=== ${title} ===`);
  try {
    log(`  result: ${JSON.stringify(await run())}`);
  } catch (error) {
    if (!(error instanceof SpritesError)) throw error;
    const e = error;
    log(
      `  threw ${e.name}: status=${e.status} body=${JSON.stringify(e.body)} message=${JSON.stringify(e.message)}`,
    );
  }
}

await block("create", () =>
  recorder((_, url) =>
    url.endsWith("/v1/sprites")
      ? Response.json({ id: "sprite_123", name: "hub-a" })
      : new Response(null, { status: 204 }),
  ).create({ name: "hub-a", memoryMb: 16384 }),
);

await block("exec without stdin (repeated cmd and env, dir)", () =>
  recorder(() => frames(3, "bar /tmp\n", "err\n")).exec(
    "hub-a",
    ["sh", "-c", 'echo "$FOO $PWD"; echo err >&2; exit 3'],
    { env: { FOO: "bar", EQ: "a=b&c" }, dir: "/tmp" },
  ),
);

await block("exec with stdin", () =>
  recorder(() => frames(7, "", "line2\n")).exec("hub-a", ["sh", "-s"], {
    stdin: "echo line2 >&2\nexit 7\n",
  }),
);

await block("service (DELETE then PUT)", () =>
  recorder((m) =>
    m === "DELETE"
      ? new Response(null, { status: 204 })
      : new Response('{"type":"started"}\n{"type":"complete"}\n'),
  ).service("hub-a", "paseo", {
    cmd: "/bin/sh",
    args: ["-c", "exec paseo daemon"],
    env: { PROBE: "2" },
    dir: "/home/sprite",
  }),
);

await block("service when DELETE is 404 (first install)", () =>
  recorder((m) =>
    m === "DELETE"
      ? new Response("service not found", { status: 404 })
      : new Response('{"type":"complete"}\n'),
  ).service("hub-a", "paseo", { cmd: "/bin/sh", args: [], env: {}, dir: "/home/sprite" }),
);

await block("hold", () =>
  recorder(() => frames(0, '{"name":"hub-hold","expires_at":"2026-09-17T12:05:00Z"}')).hold(
    "hub-a",
    "hub-hold",
    "5m",
  ),
);

await block("release (exit 0)", () =>
  recorder(() => frames(0, '{"ok":true}')).release("hub-a", "hub-hold"),
);

await block("release: exit 22 + 'returned error: 404' on stderr -> success", () =>
  recorder(() => frames(22, "", "curl: (22) The requested URL returned error: 404\n")).release(
    "hub-a",
    "hub-hold",
  ),
);

await block("release: exit 22 + 'returned error: 500' on stderr -> throws", () =>
  recorder(() => frames(22, "", "curl: (22) The requested URL returned error: 500\n")).release(
    "hub-a",
    "hub-hold",
  ),
);

await block("hold: exit 22 + 'returned error: 404' -> throws (404 only tolerated on release)", () =>
  recorder(() => frames(22, "", "curl: (22) The requested URL returned error: 404\n")).hold(
    "hub-a",
    "hub-hold",
    "5m",
  ),
);

await block("destroy (204)", () =>
  recorder(() => new Response(null, { status: 204 })).destroy("hub-a"),
);

await block("destroy (404 -> success)", () =>
  recorder(() => new Response("sprite not found", { status: 404 })).destroy("hub-a"),
);

await block("destroy (500 -> throws with HTTP status and body)", () =>
  recorder(() => new Response("internal boom", { status: 500 })).destroy("hub-a"),
);

await block("create (400 -> throws with HTTP status and body)", () =>
  recorder(() => new Response('unknown field "memory_mb"', { status: 400 })).create({
    name: "hub-a",
    memoryMb: 1,
  }),
);

await block("exec (401 -> throws)", () =>
  recorder(() => new Response("unauthorized", { status: 401 })).exec("hub-a", ["true"]),
);
