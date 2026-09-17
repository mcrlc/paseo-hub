/* oxlint-disable */
// Shared YAML fixtures for the ac-64s scripts.
export const SPRITE_TARGET = `  target:
    kind: sprite
    bootstrap: |
      npm install -g @getpaseo/cli
      paseo --version
    cwd: /home/sprite/workspace/project
    memory: 16384
    env:
      ANTHROPIC_API_KEY: plain-value
      GITHUB_TOKEN: \${{ paseo.connections.github.token }}
    worktree:
      mode: branch-off
      newBranch: hub-work
      base: origin/main
`;

export function spriteYaml(name = "sprite-review", target = SPRITE_TARGET, extraRun = ""): string {
  return `name: ${name}
on:
  manual.run: {}
run:
${target}  agent: { provider: claude, mode: bypassPermissions }
  prompt: Review it.
  max_runtime: 30m
  idle_timeout: 5m
${extraRun}`;
}

export function daemonYaml(name = "daemon-review"): string {
  return `name: ${name}
on:
  manual.run: {}
run:
  target: { daemon: devbox, cwd: /workspace }
  agent: { provider: claude, mode: bypassPermissions }
  prompt: Review it.
  max_runtime: 30m
  idle_timeout: 5m
`;
}
