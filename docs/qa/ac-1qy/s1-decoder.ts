// Scenario 1: feed decodeExec the byte sequences recorded in Spike 6 and edge variants.
import { decodeExec } from "../../../src/daemons/sprites/client.js";

const log = (line: string) => process.stdout.write(`${line}\n`);

const hex = (h: string) => Uint8Array.from(Buffer.from(h.replace(/\s/g, ""), "hex"));
const bytes = (...parts: (number | string)[]) =>
  Uint8Array.from(
    Buffer.concat(parts.map((p) => (typeof p === "number" ? Buffer.of(p) : Buffer.from(p)))),
  );

const cases: [string, Uint8Array, { stdout: string; stderr: string; exitCode: number | null }][] = [
  [
    "spike6 HTTP/2: 02 err\\n 01 out\\n 03 c8 0a",
    hex("02657272 0a 01 6f7574 0a 03 c8 0a"),
    { stdout: "out\n", stderr: "err\n", exitCode: 200 },
  ],
  [
    "spike6 HTTP/1.1 form (no trailing 0a): 02 err\\n 01 out\\n 03 c8",
    hex("02657272 0a 01 6f7574 0a 03 c8"),
    { stdout: "out\n", stderr: "err\n", exitCode: 200 },
  ],
  [
    "spike6 stdout then exit 3: 01 out\\n 03 03",
    hex("016f75740a0303"),
    { stdout: "out\n", stderr: "", exitCode: 3 },
  ],
  ["spike6 exit 0 only: 03 00", hex("0300"), { stdout: "", stderr: "", exitCode: 0 }],
  ["spike6 exit 0 over HTTP/2: 03 00 0a", hex("03000a"), { stdout: "", stderr: "", exitCode: 0 }],
  ["spike6 no exit frame: 01 ab", hex("016162"), { stdout: "ab", stderr: "", exitCode: null }],
  [
    "no exit frame, stdout ends in newline: 01 ab\\n",
    hex("0161620a"),
    { stdout: "ab\n", stderr: "", exitCode: null },
  ],
  [
    "5000-byte single stdout frame + 03 00",
    bytes(1, "x".repeat(4999) + "\n", 3, 0),
    { stdout: "x".repeat(4999) + "\n", stderr: "", exitCode: 0 },
  ],
  [
    "interleaved stdout, stderr, stdout, stderr then exit 7 over HTTP/2",
    bytes(1, "line1\n", 2, "line2\n", 1, "line3\n", 2, "e2\n", 3, 7, 0x0a),
    { stdout: "line1\nline3\n", stderr: "line2\ne2\n", exitCode: 7 },
  ],
  [
    "UTF-8 payload split across two stdout frames mid-codepoint",
    (() => {
      const t = Buffer.from("héllo ✓ 日本\n");
      return bytes(1, ...t.subarray(0, 8), 1, ...t.subarray(8), 3, 0);
    })(),
    { stdout: "héllo ✓ 日本\n", stderr: "", exitCode: 0 },
  ],
  [
    "exit code 10 (0x0a) over HTTP/1.1: 01 hi 03 0a",
    bytes(1, "hi", 3, 0x0a),
    { stdout: "hi", stderr: "", exitCode: 10 },
  ],
  [
    "exit code 10 over HTTP/2: 01 hi 03 0a 0a",
    bytes(1, "hi", 3, 0x0a, 0x0a),
    { stdout: "hi", stderr: "", exitCode: 10 },
  ],
  [
    "exit code 22 with curl stderr (release 404 shape)",
    bytes(2, "curl: (22) The requested URL returned error: 404\n", 3, 22, 0x0a),
    { stdout: "", stderr: "curl: (22) The requested URL returned error: 404\n", exitCode: 22 },
  ],
];

let failed = 0;
for (const [label, body, want] of cases) {
  const got = decodeExec(body);
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  const shown =
    body.length > 40
      ? `${Buffer.from(body.subarray(0, 12)).toString("hex")}…${Buffer.from(body.subarray(-4)).toString("hex")} (${body.length} bytes)`
      : Buffer.from(body).toString("hex");
  const gotShown = {
    ...got,
    stdout: got.stdout.length > 40 ? `<${got.stdout.length} chars>` : got.stdout,
  };
  log(
    `${ok ? "PASS" : "FAIL"} ${label}\n  body=${shown}\n  got=${JSON.stringify(gotShown)}${ok ? "" : `\n  want=${JSON.stringify(want)}`}`,
  );
}
log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
