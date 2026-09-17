/* QA evidence scripts: they print to stdout and inspect arbitrary thrown values. */
/* oxlint-disable */
import { compileHubBundle } from "../../../src/config/bundle.js";
const files = [
  {
    path: ".paseo/hub.yml",
    content:
      "environments:\n  runner:\n    kind: daemon\n    daemon: devbox\n    cwd: /repo\n  spare:\n    kind: fly\n    image: paseo/test\nagents: {}",
  },
  {
    path: ".paseo/workflows/request.yml",
    content:
      "name: request\non: manual.run\nmax_runtime: 1h\nsteps:\n  - id: work\n    environment: runner\n    max_runtime: 10m\n    idle_timeout: 1m\n    agent: { provider: test }\n    prompt: [{ text: Do it. }]",
  },
];
try {
  const b = compileHubBundle(files);
  console.log("ACCEPTED environments:", JSON.stringify(b.configuration.environments));
} catch (e) {
  console.log("REJECTED:", (e as Error).message);
}

// A normalized configuration main could have stored for that bundle, read back through HEAD's compiled parser.
import { parseCompiledHubConfig } from "../../../src/config/compiler.js";
try {
  parseCompiledHubConfig({
    environments: [
      { name: "runner", kind: "daemon", daemon: "devbox", cwd: "/repo", daemonId: "daemon-1" },
      { name: "spare", kind: "fly", image: "paseo/test" },
    ],
    triggers: [],
  });
  console.log("stored normalized config with a fly environment: parsed");
} catch (e) {
  console.log(
    `stored normalized config with a fly environment: REJECTED: ${(e as Error).message.split("\n")[0]}`,
  );
}
