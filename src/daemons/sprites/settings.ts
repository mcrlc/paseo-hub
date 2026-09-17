import type { AuthServer } from "../../auth/server.js";
import { capabilitiesFor } from "../../auth/organization-policy.js";
import type { Database } from "../../db/types.js";
import { resolveRouteTenant } from "../../projects/access.js";
import { ProjectCommandError } from "../../projects/command-error.js";
import { spritesEnvKeyError, spritesEnvValueError } from "./env.js";

export class SpritesTokenRejectedError extends Error {
  readonly code = "invalidInput";

  constructor() {
    super("Sprites rejected this token.");
    this.name = "SpritesTokenRejectedError";
  }
}

export class SpritesTokenCheckError extends Error {
  constructor(httpStatus: number) {
    super(
      `Sprites answered HTTP ${httpStatus} when Hub checked the token. The stored token is unchanged.`,
    );
    this.name = "SpritesTokenCheckError";
  }
}

export class SpritesEnvInputError extends Error {
  readonly code = "invalidInput";

  constructor(message: string) {
    super(message);
    this.name = "SpritesEnvInputError";
  }
}

export class SpritesEnvNotFoundError extends Error {
  readonly code = "notFound";

  constructor() {
    super("No such variable.");
    this.name = "SpritesEnvNotFoundError";
  }
}

export class SpritesSettings {
  private readonly fetch: typeof fetch;

  constructor(
    private readonly database: Database,
    private readonly auth: AuthServer,
    options: { fetch?: typeof fetch } = {},
  ) {
    this.fetch = options.fetch ?? fetch;
  }

  async snapshot(request: Request, organizationSlug: string) {
    const { tenant } = await this.manager(request, organizationSlug);
    const stored = await this.database.getOrganizationSpritesConfiguration(tenant.organization.id);
    return {
      configured: stored !== undefined,
      memoryMb: stored?.memoryMb ?? null,
      envKeys: Object.keys(stored?.env ?? {}).sort(),
      updatedAt: stored?.updatedAt.toISOString() ?? null,
      updatedByUserId: stored?.updatedByUserId ?? null,
    };
  }

  async save(
    request: Request,
    organizationSlug: string,
    input: { token: string; memoryMb: number },
  ) {
    const { account, tenant } = await this.manager(request, organizationSlug);
    const response = await this.fetch("https://api.sprites.dev/v1/sprites", {
      headers: { Authorization: `Bearer ${input.token}` },
    });
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) throw new SpritesTokenRejectedError();
    if (!response.ok) throw new SpritesTokenCheckError(response.status);
    await this.database.upsertOrganizationSpritesConfiguration({
      organizationId: tenant.organization.id,
      token: input.token,
      memoryMb: input.memoryMb,
      updatedByUserId: account.account.id,
    });
  }

  async setEnv(request: Request, organizationSlug: string, input: { key: string; value: string }) {
    const { tenant } = await this.manager(request, organizationSlug);
    const value = input.value.trim();
    const error = spritesEnvKeyError(input.key) ?? spritesEnvValueError(value);
    if (error !== undefined) throw new SpritesEnvInputError(error);
    const stored = await this.database.setOrganizationSpritesEnv({
      organizationId: tenant.organization.id,
      key: input.key,
      value,
    });
    if (stored === undefined) {
      throw new SpritesEnvInputError("Connect Sprites with an organization token first.");
    }
  }

  async removeEnv(request: Request, organizationSlug: string, input: { key: string }) {
    const { tenant } = await this.manager(request, organizationSlug);
    const stored = await this.database.removeOrganizationSpritesEnv({
      organizationId: tenant.organization.id,
      key: input.key,
    });
    if (stored === undefined) throw new SpritesEnvNotFoundError();
  }

  private async manager(request: Request, organizationSlug: string) {
    const resolved = await resolveRouteTenant(this.auth, this.database, request, {
      organizationSlug,
    });
    if (!capabilitiesFor(resolved.tenant.membership.role).manageResources) {
      throw new ProjectCommandError("forbidden");
    }
    return resolved;
  }
}

export type SpritesSettingsSnapshot = Awaited<ReturnType<SpritesSettings["snapshot"]>>;
