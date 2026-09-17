// Decodes the body of POST /v1/sprites/:name/exec. Each HTTP chunk is one frame: a channel
// byte (1 stdout, 2 stderr, 3 exit) followed by payload; the exit frame is last and carries one
// code byte (HTTP/2 responses append a newline after it).
// ponytail: fetch() does not preserve chunk boundaries, so channel bytes are stripped wherever
// they appear; binary stdout containing 0x01/0x02 would be corrupted. Fine for logs and JSON.
export function decodeExec(buf) {
  if (buf.at(-1) === 0x0a && buf.at(-3) === 3) buf = buf.subarray(0, -1);
  const exitCode = buf.at(-2) === 3 ? buf.at(-1) : null;
  const body = exitCode === null ? buf : buf.subarray(0, -2);
  const out = [[], []];
  let ch = 0;
  for (const b of body) {
    if (b === 1 || b === 2) ch = b - 1;
    else out[ch].push(b);
  }
  return {
    stdout: Buffer.from(out[0]).toString(),
    stderr: Buffer.from(out[1]).toString(),
    exitCode,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [hex, want] of [
    ["026572720a016f75740a03c80a", { stdout: "out\n", stderr: "err\n", exitCode: 200 }],
    ["016f75740a0303", { stdout: "out\n", stderr: "", exitCode: 3 }],
    ["0300", { stdout: "", stderr: "", exitCode: 0 }],
    ["016162", { stdout: "ab", stderr: "", exitCode: null }],
  ]) {
    const got = decodeExec(Buffer.from(hex, "hex"));
    console.assert(JSON.stringify(got) === JSON.stringify(want), `framing self-check ${hex}`, got);
  }
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    console.log(JSON.stringify(decodeExec(Buffer.concat(chunks))));
  }
}
