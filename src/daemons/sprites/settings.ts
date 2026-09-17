import type { AuthServer } from "../../auth/server.js";
import { capabilitiesFor } from "../../auth/organization-policy.js";
import type { Database } from "../../db/types.js";
import { resolveRouteTenant } from "../../projects/access.js";
import { ProjectCommandError } from "../../projects/command-error.js";

export class SpritesSettings {
  constructor(
    private readonly database: Database,
    private readonly auth: AuthServer,
  ) {}

  async snapshot(request: Request, organizationSlug: string) {
    const { tenant } = await resolveRouteTenant(this.auth, this.database, request, {
      organizationSlug,
    });
    const stored = await this.database.getOrganizationSpritesConfiguration(tenant.organization.id);
    return {
      configured: stored !== undefined,
      memoryMb: stored?.memoryMb ?? null,
      updatedAt: stored?.updatedAt.toISOString() ?? null,
      updatedByUserId: stored?.updatedByUserId ?? null,
    };
  }

  async save(
    request: Request,
    organizationSlug: string,
    input: { token: string; memoryMb: number },
  ) {
    const { account, tenant } = await resolveRouteTenant(this.auth, this.database, request, {
      organizationSlug,
    });
    if (!capabilitiesFor(tenant.membership.role).manageResources) {
      throw new ProjectCommandError("forbidden");
    }
    await this.database.upsertOrganizationSpritesConfiguration({
      organizationId: tenant.organization.id,
      token: input.token,
      memoryMb: input.memoryMb,
      updatedByUserId: account.account.id,
    });
  }
}

export type SpritesSettingsSnapshot = Awaited<ReturnType<SpritesSettings["snapshot"]>>;
