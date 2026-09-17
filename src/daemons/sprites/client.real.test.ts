import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "vitest";
import { createSpritesClient } from "./client.js";

const TOKEN = process.env["SPRITES_TOKEN"];

describe.skipIf(TOKEN === undefined)("Sprites client against a real sprite", () => {
  it("drives the provider surface end to end", { timeout: 300_000 }, async () => {
    const client = createSpritesClient({ token: TOKEN! });
    const name = `hub-it-${randomBytes(3).toString("hex")}`;
    try {
      assert.ok(await client.create({ name, memoryMb: 16384 }));

      assert.deepEqual(await client.exec(name, ["sh", "-c", "echo out; echo err >&2; exit 3"]), {
        stdout: "out\n",
        stderr: "err\n",
        exitCode: 3,
      });
      assert.deepEqual(
        await client.exec(name, ["sh", "-s"], {
          stdin: 'echo "$FOO $PWD"\necho line2 >&2\nexit 7\n',
          env: { FOO: "bar" },
          dir: "/tmp",
        }),
        { stdout: "bar /tmp\n", stderr: "line2\n", exitCode: 7 },
      );

      assert.equal(await client.hold(name, "hub-it", "5m"), true);
      assert.equal(await client.hold(name, "hub-it", "5m"), true);
      assert.equal(await client.hold(name, "hub-it", "5m", { refresh: true }), true);
      await client.release(name, "hub-it");
      await client.release(name, "hub-it");
      assert.equal(await client.hold(name, "hub-it", "5m", { refresh: true }), false);

      const probe = (value: string) => ({
        cmd: "/bin/sh",
        args: ["-c", 'echo "$PROBE" > /home/sprite/probe.txt; exec sleep 3600'],
        env: { PROBE: value },
        dir: "/home/sprite",
      });
      await client.service(name, "probe", probe("1"));
      await client.service(name, "probe", probe("2"));
      let probed = "";
      for (let attempt = 0; attempt < 20 && probed !== "2\n"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        probed = (await client.exec(name, ["cat", "/home/sprite/probe.txt"])).stdout;
      }
      assert.equal(probed, "2\n");
    } finally {
      await client.destroy(name);
    }
  });
});
