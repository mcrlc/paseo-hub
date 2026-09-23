import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import { createSpritesClient, decodeExec, SpritesError, SpritesTimeoutError } from "./client.js";

describe("decodeExec", () => {
  it("decodes a zero exit", () => {
    assert.deepEqual(decodeExec(hex("0300")), { stdout: "", stderr: "", exitCode: 0 });
  });

  it("decodes a non-zero exit after stdout", () => {
    assert.deepEqual(decodeExec(hex("016f75740a0303")), {
      stdout: "out\n",
      stderr: "",
      exitCode: 3,
    });
  });

  it("separates interleaved stdout and stderr", () => {
    assert.deepEqual(decodeExec(hex("016f6e650a026572720a0174776f0a0300")), {
      stdout: "one\ntwo\n",
      stderr: "err\n",
      exitCode: 0,
    });
  });

  it("drops the newline HTTP/2 appends after the exit frame", () => {
    assert.deepEqual(decodeExec(hex("026572720a016f75740a03c80a")), {
      stdout: "out\n",
      stderr: "err\n",
      exitCode: 200,
    });
  });

  it("reports a missing exit frame as a null exit code", () => {
    assert.deepEqual(decodeExec(hex("016162")), { stdout: "ab", stderr: "", exitCode: null });
  });

  it("decodes UTF-8 payloads", () => {
    const text = new TextEncoder().encode("héllo ✓\n");
    assert.deepEqual(decodeExec(new Uint8Array([1, ...text, 3, 0])), {
      stdout: "héllo ✓\n",
      stderr: "",
      exitCode: 0,
    });
  });
});

describe("Sprites client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds the exec query with repeated cmd and env and sends stdin only when given", async () => {
    const stub = stubFetch(() => execResponse(0));
    const client = createSpritesClient({ token: "token", fetch: stub.fetch });

    await client.exec("sprite-a", ["sh", "-c", "echo $FOO"], {
      env: { FOO: "bar", BAZ: "a=b" },
      dir: "/tmp",
    });
    await client.exec("sprite-a", ["sh", "-s"], { stdin: "echo hi\n" });

    const [plain, withStdin] = stub.requests;
    const plainUrl = new URL(plain!.url);
    assert.equal(plain!.method, "POST");
    assert.equal(
      plainUrl.origin + plainUrl.pathname,
      "https://api.sprites.dev/v1/sprites/sprite-a/exec",
    );
    assert.deepEqual(plainUrl.searchParams.getAll("cmd"), ["sh", "-c", "echo $FOO"]);
    assert.deepEqual(plainUrl.searchParams.getAll("env"), ["FOO=bar", "BAZ=a=b"]);
    assert.equal(plainUrl.searchParams.get("dir"), "/tmp");
    assert.equal(plainUrl.searchParams.has("stdin"), false);
    assert.equal(plain!.body, undefined);
    assert.equal(plain!.authorization, "Bearer token");

    const stdinUrl = new URL(withStdin!.url);
    assert.deepEqual(stdinUrl.searchParams.getAll("cmd"), ["sh", "-s"]);
    assert.equal(stdinUrl.searchParams.get("stdin"), "true");
    assert.equal(withStdin!.body, "echo hi\n");
  });

  it("creates a sprite and applies its memory limit", async () => {
    const stub = stubFetch((request) =>
      request.url.endsWith("/v1/sprites")
        ? Response.json({ id: "sprite-id", name: "sprite-a" }, { status: 201 })
        : new Response(null, { status: 204 }),
    );
    const client = createSpritesClient({ token: "token", fetch: stub.fetch });

    assert.equal(await client.create({ name: "sprite-a", memoryMb: 16384 }), "sprite-id");
    assert.deepEqual(
      stub.requests.map(({ method, url, body }) => [method, url, body]),
      [
        ["POST", "https://api.sprites.dev/v1/sprites", '{"name":"sprite-a"}'],
        [
          "POST",
          "https://api.sprites.dev/v1/sprites/sprite-a/policy/resources",
          '{"memory":{"limit_mb":16384}}',
        ],
      ],
    );
  });

  it("updates the memory limit on its own", async () => {
    const stub = stubFetch(() => new Response(null, { status: 204 }));
    const client = createSpritesClient({ token: "token", fetch: stub.fetch });

    await client.setMemory("sprite-a", 4096);

    assert.deepEqual(
      stub.requests.map(({ method, url, body }) => [method, url, body]),
      [
        [
          "POST",
          "https://api.sprites.dev/v1/sprites/sprite-a/policy/resources",
          '{"memory":{"limit_mb":4096}}',
        ],
      ],
    );
  });

  it("deletes a service before writing it and tolerates a missing one", async () => {
    const stub = stubFetch((request) =>
      request.method === "DELETE"
        ? new Response("service not found", { status: 404 })
        : new Response('{"type":"started"}\n{"type":"complete"}\n'),
    );
    const client = createSpritesClient({ token: "token", fetch: stub.fetch });

    const definition = {
      cmd: "/bin/sh",
      args: ["-c", "true"],
      env: { A: "1" },
      dir: "/home/sprite",
    };
    await client.service("sprite-a", "paseo", definition);

    assert.deepEqual(
      stub.requests.map(({ method, url }) => [method, url]),
      [
        ["DELETE", "https://api.sprites.dev/v1/sprites/sprite-a/services/paseo"],
        ["PUT", "https://api.sprites.dev/v1/sprites/sprite-a/services/paseo"],
      ],
    );
    assert.deepEqual(JSON.parse(stub.requests[1]!.body!), definition);
  });

  it("rejects a service write whose stream never completes", async () => {
    const stub = stubFetch((request) =>
      request.method === "DELETE"
        ? new Response(null, { status: 204 })
        : new Response('{"type":"started"}\n'),
    );
    const client = createSpritesClient({ token: "token", fetch: stub.fetch });

    await assert.rejects(
      client.service("sprite-a", "paseo", { cmd: "/bin/sh", args: [], env: {}, dir: "/" }),
      (error: unknown) => error instanceof SpritesError && error.body === '{"type":"started"}\n',
    );
  });

  it("holds by upserting the task with PUT through sprite-env curl", async () => {
    const stub = stubFetch(() => execResponse(0, '{"expires_at":"later"}'));
    const client = createSpritesClient({ token: "token", fetch: stub.fetch });

    await client.hold("sprite-a", "hub-hold", "60m");
    assert.deepEqual(new URL(stub.requests[0]!.url).searchParams.getAll("cmd"), [
      "sprite-env",
      "curl",
      "-s",
      "-X",
      "PUT",
      "/v1/tasks/hub-hold",
      "-d",
      '{"name":"hub-hold","expire":"60m"}',
    ]);
  });

  it("treats a missing task or sprite as released or destroyed", async () => {
    const stub = stubFetch((request) =>
      request.url.includes("/exec")
        ? execResponse(22, "", "curl: (22) The requested URL returned error: 404")
        : new Response("sprite not found", { status: 404 }),
    );
    const client = createSpritesClient({ token: "token", fetch: stub.fetch });

    await client.release("sprite-a", "hub-hold");
    await client.destroy("sprite-a");

    assert.deepEqual(new URL(stub.requests[0]!.url).searchParams.getAll("cmd").slice(2), [
      "-s",
      "-X",
      "DELETE",
      "/v1/tasks/hub-hold",
    ]);
    assert.deepEqual(stub.requests[1]!.method, "DELETE");
    assert.equal(stub.requests[1]!.url, "https://api.sprites.dev/v1/sprites/sprite-a");

    const destroyed = stubFetch(() => new Response("sprite not found", { status: 404 }));
    const client404 = createSpritesClient({ token: "token", fetch: destroyed.fetch });

    await client404.release("sprite-a", "hub-hold");

    assert.equal(destroyed.requests.length, 1);
    await assert.rejects(client404.hold("sprite-a", "hub-hold", "60m"), /Sprites API 404/u);
  });

  it("raises provider failures with their status and body", async () => {
    const client = createSpritesClient({
      token: "token",
      fetch: stubFetch(() => new Response("unknown field memory_mb", { status: 400 })).fetch,
    });

    await assert.rejects(
      client.create({ name: "sprite-a", memoryMb: 1 }),
      (error: unknown) =>
        error instanceof SpritesError &&
        error.status === 400 &&
        error.body === "unknown field memory_mb",
    );

    const inSprite = createSpritesClient({
      token: "token",
      fetch: stubFetch(() =>
        execResponse(22, "", "curl: (22) The requested URL returned error: 500"),
      ).fetch,
    });
    await assert.rejects(
      inSprite.release("sprite-a", "hub-hold"),
      (error: unknown) =>
        error instanceof SpritesError &&
        error.status === 500 &&
        error.body === "curl: (22) The requested URL returned error: 500",
    );

    const unreachable = createSpritesClient({
      token: "token",
      fetch: stubFetch(() => execResponse(7, "", "curl: (7) Failed to connect")).fetch,
    });
    await assert.rejects(
      unreachable.hold("sprite-a", "hub-hold", "60m"),
      (error: unknown) => error instanceof SpritesError && error.status === 7,
    );
  });

  it("gives hold and release the task budget and an exec its own", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const client = createSpritesClient({
      token: "token",
      fetch: stubFetch((request) => {
        if (request.url.includes("/exec")) return execResponse(0);
        if (request.method === "PUT") return new Response('{"type":"complete"}\n');
        if (request.url.endsWith("/v1/sprites")) return Response.json({ id: "sprite-id" });
        return new Response(null, { status: 204 });
      }).fetch,
    });

    await client.create({ name: "sprite-a", memoryMb: 4096 });
    await client.service("sprite-a", "paseo", { cmd: "/bin/sh", args: [], env: {}, dir: "/" });
    await client.hold("sprite-a", "hub-hold", "60m");
    await client.release("sprite-a", "hub-hold");
    await client.destroy("sprite-a");
    await client.exec("sprite-a", ["true"]);
    await client.exec("sprite-a", ["true"], { timeoutMs: 900_000 });

    assert.deepEqual(
      timeout.mock.calls.map(([ms]) => ms),
      [60_000, 60_000, 60_000, 60_000, 20_000, 20_000, 60_000, 60_000, 900_000],
    );
  });

  it("times out a hold whose exec never answers, naming the call and its budget", async () => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(10));
    let signal: AbortSignal | undefined;
    const client = createSpritesClient({
      token: "token",
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          signal = init?.signal ?? undefined;
          signal?.addEventListener("abort", () => reject(signal?.reason));
        }),
    });

    await assert.rejects(
      client.hold("sprite-a", "hub-hold", "60m"),
      (error: unknown) =>
        error instanceof SpritesTimeoutError &&
        error.code === "sprites_timeout" &&
        error.message === "Sprites API 0: POST /v1/sprites/sprite-a/exec timed out after 20 s",
    );
    assert.equal(signal?.aborted, true);
  });

  it("times out an exec whose output stream stops before the exit frame", async () => {
    const client = createSpritesClient({
      token: "token",
      fetch: async (_input, init) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 0x68, 0x69]));
            init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
          },
        });
        return new Response(body);
      },
    });

    await assert.rejects(
      client.exec("sprite-a", ["sh", "-c", "true"], { timeoutMs: 10 }),
      (error: unknown) =>
        error instanceof SpritesTimeoutError &&
        error.message === "Sprites API 0: POST /v1/sprites/sprite-a/exec timed out after 0.01 s",
    );
  });
});

interface RecordedRequest {
  method: string;
  url: string;
  body: string | undefined;
  authorization: string | null;
}

function stubFetch(respond: (request: RecordedRequest) => Response) {
  const requests: RecordedRequest[] = [];
  const fetchStub: typeof fetch = async (input, init) => {
    const request: RecordedRequest = {
      method: init?.method ?? "GET",
      url: input instanceof Request ? input.url : input.toString(),
      body: typeof init?.body === "string" ? init.body : undefined,
      authorization: new Headers(init?.headers).get("authorization"),
    };
    requests.push(request);
    return respond(request);
  };
  return { requests, fetch: fetchStub };
}

function execResponse(exitCode: number, stdout = "", stderr = ""): Response {
  const encoder = new TextEncoder();
  const frames = [1, ...encoder.encode(stdout), 2, ...encoder.encode(stderr), 3, exitCode];
  return new Response(new Uint8Array(frames), {
    headers: { "Content-Type": "application/octet-stream" },
  });
}

function hex(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "hex"));
}
