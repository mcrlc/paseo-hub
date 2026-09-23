import type { AuthServer } from "../../auth/server.js";
import { capabilitiesFor } from "../../auth/organization-policy.js";
import type { Database } from "../../db/types.js";
import { resolveRouteTenant } from "../../projects/access.js";
import { ProjectCommandError } from "../../projects/command-error.js";
import { REQUEST_TIMEOUT_MS } from "./client.js";
import { spritesEnvKeyError, spritesEnvValueError } from "./env.js";

export class SpritesTokenRejectedError extends Error {
  readonly code = "invalidInput";

  constructor() {
    super("Sprites rejected this token.");
    this.name = "SpritesTokenRejectedError";
  }
}

export class SpritesTokenCheckError extends Error {
  constructor(problem: string) {
    super(`${problem} when Hub checked the token. The stored token is unchanged.`);
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
  private readonly rewriteServices: (organizationId: string) => Promise<void>;

  constructor(
    private readonly database: Database,
    private readonly auth: AuthServer,
    options: {
      fetch?: typeof fetch;
      rewriteServices?: (organizationId: string) => Promise<void>;
    } = {},
  ) {
    this.fetch = options.fetch ?? fetch;
    this.rewriteServices = options.rewriteServices ?? (() => Promise.resolve());
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
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetch("https://api.sprites.dev/v1/sprites", {
        headers: { Authorization: `Bearer ${input.token}` },
        signal,
      });
    } catch (error) {
      if (!signal.aborted) throw error;
      throw new SpritesTokenCheckError(
        `Sprites did not answer within ${REQUEST_TIMEOUT_MS / 1000} s`,
      );
    }
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) throw new SpritesTokenRejectedError();
    if (!response.ok) throw new SpritesTokenCheckError(`Sprites answered HTTP ${response.status}`);
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
    await this.rewriteServices(tenant.organization.id);
  }

  async removeEnv(request: Request, organizationSlug: string, input: { key: string }) {
    const { tenant } = await this.manager(request, organizationSlug);
    const stored = await this.database.removeOrganizationSpritesEnv({
      organizationId: tenant.organization.id,
      key: input.key,
    });
    if (stored === undefined) throw new SpritesEnvNotFoundError();
    await this.rewriteServices(tenant.organization.id);
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
