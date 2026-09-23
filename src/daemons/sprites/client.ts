import { z } from "zod";

const SPRITES_API_URL = "https://api.sprites.dev";
const CURL_HTTP_ERROR_EXIT_CODE = 22;
export const REQUEST_TIMEOUT_MS = 60_000;
const TASK_TIMEOUT_MS = 20_000;
export const PASEO_INSTALL_TIMEOUT_MS = 10 * 60_000;
export const BOOTSTRAP_TIMEOUT_MS = 30 * 60_000;
export const HUB_CONNECT_TIMEOUT_MS = 15 * 60_000;

export class SpritesError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Sprites API ${status}: ${body}`);
    this.name = "SpritesError";
  }
}

export class SpritesTimeoutError extends SpritesError {
  readonly code = "sprites_timeout";

  constructor(body: string) {
    super(0, body);
    this.name = "SpritesTimeoutError";
  }
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface ExecOptions {
  env?: Record<string, string>;
  dir?: string;
  stdin?: string;
  timeoutMs?: number;
}

export interface ServiceDefinition {
  cmd: string;
  args: string[];
  env: Record<string, string>;
  dir: string;
}

export type SpritesClient = ReturnType<typeof createSpritesClient>;

const CreatedSpriteSchema = z.object({ id: z.string().min(1) });

// fetch() does not preserve chunk boundaries, so channel bytes are stripped wherever they appear; binary stdout containing 0x01 or 0x02 is corrupted.
export function decodeExec(body: Uint8Array): ExecResult {
  let frames = body;
  if (frames.at(-1) === 0x0a && frames.at(-3) === 3) frames = frames.subarray(0, -1);
  const exitCode = frames.at(-2) === 3 ? (frames.at(-1) ?? null) : null;
  if (exitCode !== null) frames = frames.subarray(0, -2);
  const output: [number[], number[]] = [[], []];
  let channel = 0;
  for (const byte of frames) {
    if (byte === 1 || byte === 2) channel = byte - 1;
    else output[channel]!.push(byte);
  }
  const decoder = new TextDecoder();
  return {
    stdout: decoder.decode(new Uint8Array(output[0])),
    stderr: decoder.decode(new Uint8Array(output[1])),
    exitCode,
  };
}

export function createSpritesClient(options: { token: string; fetch?: typeof fetch }) {
  const fetchImpl = options.fetch ?? fetch;

  async function request(
    method: string,
    path: string,
    init: { body?: string; json?: unknown; allowNotFound?: boolean; timeoutMs?: number } = {},
  ): Promise<{ status: number; body: Uint8Array }> {
    const headers: Record<string, string> = { Authorization: `Bearer ${options.token}` };
    let body = init.body;
    if (init.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.json);
    }
    const timeoutMs = init.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetchImpl(`${SPRITES_API_URL}${path}`, {
        method,
        headers,
        signal,
        ...(body === undefined ? {} : { body }),
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (response.ok || (init.allowNotFound === true && response.status === 404)) {
        return { status: response.status, body: bytes };
      }
      throw new SpritesError(response.status, new TextDecoder().decode(bytes));
    } catch (error) {
      if (!signal.aborted) throw error;
      const { pathname } = new URL(path, SPRITES_API_URL);
      throw new SpritesTimeoutError(`${method} ${pathname} timed out after ${timeoutMs / 1000} s`);
    }
  }

  async function execRequest(
    name: string,
    argv: string[],
    execOptions: ExecOptions,
    allowNotFound: boolean,
  ) {
    const query = new URLSearchParams();
    for (const arg of argv) query.append("cmd", arg);
    for (const [key, value] of Object.entries(execOptions.env ?? {})) {
      query.append("env", `${key}=${value}`);
    }
    if (execOptions.dir !== undefined) query.set("dir", execOptions.dir);
    if (execOptions.stdin !== undefined) query.set("stdin", "true");
    return request("POST", `${spritePath(name)}/exec?${query}`, {
      ...(execOptions.stdin === undefined ? {} : { body: execOptions.stdin }),
      allowNotFound,
      ...(execOptions.timeoutMs === undefined ? {} : { timeoutMs: execOptions.timeoutMs }),
    });
  }

  async function exec(name: string, argv: string[], execOptions: ExecOptions = {}) {
    return decodeExec((await execRequest(name, argv, execOptions, false)).body);
  }

  async function taskRequest(name: string, curlArgs: string[], allowNotFound = false) {
    const argv = ["sprite-env", "curl", "-s", ...curlArgs];
    const response = await execRequest(name, argv, { timeoutMs: TASK_TIMEOUT_MS }, allowNotFound);
    // A destroyed sprite answers 404 here, which for a release is the same as a missing task.
    if (response.status === 404) return;
    const result = decodeExec(response.body);
    if (result.exitCode === 0) return;
    if (
      allowNotFound &&
      result.exitCode === CURL_HTTP_ERROR_EXIT_CODE &&
      result.stderr.includes("returned error: 404")
    ) {
      return;
    }
    const httpStatus = /returned error: (\d{3})/u.exec(result.stderr)?.[1];
    throw new SpritesError(
      httpStatus === undefined ? (result.exitCode ?? 0) : Number(httpStatus),
      `${result.stdout}${result.stderr}`,
    );
  }

  async function setMemory(name: string, memoryMb: number): Promise<void> {
    await request("POST", `${spritePath(name)}/policy/resources`, {
      json: { memory: { limit_mb: memoryMb } },
    });
  }

  return {
    async create(input: { name: string; memoryMb: number }): Promise<string> {
      const response = await request("POST", "/v1/sprites", { json: { name: input.name } });
      const { id } = CreatedSpriteSchema.parse(JSON.parse(new TextDecoder().decode(response.body)));
      await setMemory(input.name, input.memoryMb);
      return id;
    },

    exec,

    setMemory,

    async service(name: string, service: string, definition: ServiceDefinition): Promise<void> {
      const path = `${spritePath(name)}/services/${encodeURIComponent(service)}`;
      await request("DELETE", path, { allowNotFound: true });
      const response = await request("PUT", path, { json: definition });
      const events = new TextDecoder().decode(response.body);
      if (!/"type":\s*"complete"/u.test(events)) throw new SpritesError(response.status, events);
    },

    async hold(name: string, task: string, expire: string): Promise<void> {
      const body = JSON.stringify({ name: task, expire });
      await taskRequest(name, ["-X", "PUT", taskPath(task), "-d", body]);
    },

    async release(name: string, task: string): Promise<void> {
      await taskRequest(name, ["-X", "DELETE", taskPath(task)], true);
    },

    async destroy(name: string): Promise<void> {
      await request("DELETE", spritePath(name), { allowNotFound: true });
    },
  };
}

function spritePath(name: string): string {
  return `/v1/sprites/${encodeURIComponent(name)}`;
}

function taskPath(task: string): string {
  return `/v1/tasks/${encodeURIComponent(task)}`;
}
