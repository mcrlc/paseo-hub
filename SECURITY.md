# Security

Please report security vulnerabilities through GitHub's private vulnerability reporting for this repository. Do not open a public issue for a suspected vulnerability.

## Sprite targets

A trigger with a sprite target runs its agent on a Fly Sprite that Hub creates in the Sprites organization whose token the Hub organization configured. See [`docs/sprite-targets-guide.md`](docs/sprite-targets-guide.md) for how to author one.

- **The bootstrap is the trust boundary.** A sprite runs untrusted trigger input, such as pull request comments, with whatever the authored `bootstrap` installed and every credential it placed on the sprite. Install and store only what the agent needs.
- **The database holds shell access to your sprites.** Hub stores the Sprites org token unencrypted in its database. The token can execute commands in every sprite in the organization. Protect the database, its backups, and anyone with read access to them accordingly.
- **Sprite credentials outlive executions.** Provider keys in the target's `env` and any long-lived GitHub credential placed on the sprite are not per-execution leases. They live as long as the sprite and reach every agent on it. Use a fine-grained GitHub token scoped to the one repository, because untrusted pull request comments reach an agent holding it. A provider key written as a literal value in the target's `env` is also stored in every saved revision of the trigger's YAML. A trigger that uses `run.github` instead gets leased tokens revoked at terminal and gives up continuation across idle days.
- **A sprite has no inbound surface.** Its URL stays organization-only, no service binds an HTTP port, and all traffic is the daemon's outbound connection to Hub. `PASEO_PASSWORD` is set, so a misconfiguration that exposes the daemon port does not leave it open.
- **Enrollment keys are single-purpose.** Hub enrolls each sprite with an API key scoped to `daemons:enroll` only and revokes it after enrollment.
