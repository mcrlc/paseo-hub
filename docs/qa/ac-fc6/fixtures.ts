/* QA evidence scripts: they print to stdout and inspect arbitrary thrown values. */
/* oxlint-disable */
// Realistic single-run trigger documents without `run.target.kind`.
// Sources: src/triggers/configuration/index.test.ts, editor.test.ts, and the e2e harness manual.run trigger.
export const FIXTURES: Record<string, string> = {
  "engineering-requests (index.test.ts)": `
name: engineering-requests
enabled: true
on:
  slack.mention:
    connection: acme-slack
    filters:
      channels: [engineering]
      from_users: [U0BNGPZEXT2]
  github.issue_comment:
    connection: getpaseo-github
    filters:
      contains: "@paseo-bot"
      from_users: [boudra]
inputs:
  model:
    type: string
    default: codex
    choices: [codex, claude]
run:
  target:
    daemon: devbox
    cwd: /workspace/company
  agent:
    select: \${{ paseo.inputs.model }}
    choices:
      codex:
        provider: codex
        model: gpt-5.6-sol
      claude:
        provider: claude
        model: claude-opus-5
  max_runtime: 90m
  idle_timeout: 10m
  github:
    connection: getpaseo-github
    repositories: [getpaseo/paseo, getpaseo/hub]
    permissions:
      contents: write
      pull_requests: write
  prompt: |
    Use Paseo when delegation is useful.
    \${{ paseo.prompt }}
  outputs:
    slack.reply:
      max: 5
`,
  "advanced with worktree (editor.test.ts)": `# keep this heading
name: answer
enabled: true
on:
  slack.mention:
    connection: company
    filters:
      from_users: ["*"]
      channels: [engineering]
inputs:
  urgency:
    type: string
    default: normal
max_runtime: 4h
run:
  target:
    daemon: office
    cwd: /workspace
    worktree:
      mode: branch-off
      newBranch: hub-work
  agent:
    provider: codex
    model: gpt-5.4
    mode: full-access
    thinkingOptionId: xhigh
    options:
      sandbox_mode: workspace-write
      approval_policy: never
  prompt: Handle it.
  max_runtime: 3h
  idle_timeout: 15m
  startup_timeout: 3m
  env:
    TEAM: core
  github:
    connection: company-github
    repositories: [paseo/hub]
  output:
    schema:
      type: object
  outputs:
    slack.reply:
      max: 3
  auto_archive: false
`,
  "continuation key + checkout-pr worktree": `
name: pr-review
on:
  github.pull_request_opened:
    connection: getpaseo-github
    filters:
      repo: getpaseo/hub
      from_users: [boudra]
inputs:
  ticket:
    type: string
    default: none
run:
  target:
    daemon: reviewer
    cwd: /srv/hub
    worktree:
      mode: checkout-pr
      prNumber: 42
  agent:
    provider: claude
    model: claude-opus-5
  continuation:
    mode: key
    key: "ticket-\${{ paseo.inputs.ticket }}"
  prompt: Review the pull request.
`,
  "manual.run deploy (e2e harness)": `
name: deploy
on:
  manual.run:
    filters:
      from_users: [phase-five-operator]
max_runtime: 2h
run:
  target:
    daemon: phase-five-daemon
    cwd: /tmp/hub-e2e-workspace
  agent:
    provider: hub-e2e
  max_runtime: 1h
  idle_timeout: 5m
  prompt: Deploy requested for phase-five-operator
  outputs:
    hub.e2e: {}
`,
  "schedule.tick with continuation new": `
name: nightly
on:
  schedule.tick:
    recurrence:
      timezone: Europe/Berlin
      start: "2026-01-01T02:00:00"
      rule: FREQ=DAILY
run:
  target:
    daemon: devbox
    cwd: /workspace/company
    worktree:
      mode: checkout-branch
      branch: main
  agent:
    provider: codex
  continuation:
    mode: new
  prompt: Run the nightly sweep.
  auto_archive: true
`,
};

export function withExplicitKind(yaml: string): string {
  const next = yaml.replace("  target:\n", "  target:\n    kind: daemon\n");
  if (next === yaml) throw new Error("fixture has no run.target");
  return next;
}
