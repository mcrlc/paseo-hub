import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { respondOk, type Err, type Result } from "../contract/respond.js";
import { respondWithFailure } from "../failures/index.js";
import { getApplication } from "../server/runtime.js";
import type { TriggerDashboard } from "./dashboard.js";

const scopeSchema = z.object({ organizationSlug: z.string().trim().min(1).max(100) });
const saveSchema = scopeSchema.extend({
  triggerId: z.string().uuid().optional(),
  yaml: z.string().min(1),
});

export const triggerSnapshot = createServerFn({ method: "GET" })
  .validator(scopeSchema)
  .handler(async ({ data }): Promise<Result<TriggerSnapshot>> => {
    try {
      const dashboard = (await getApplication()).triggerDashboard;
      if (dashboard == null) throw new Error("trigger dashboard unavailable");
      return respondOk(await dashboard.snapshot(getRequest(), data.organizationSlug));
    } catch (error) {
      return respondWithFailure(error, triggerContext("trigger.list", data.organizationSlug), {
        fallback: "Hub couldn't load this organization's triggers. Reload the page.",
      });
    }
  });

export const saveTrigger = createServerFn({ method: "POST" })
  .validator(saveSchema)
  .handler(async ({ data }): Promise<Result<{ state: "complete" }>> => {
    try {
      const dashboard = (await getApplication()).triggerDashboard;
      if (dashboard == null) throw new Error("trigger dashboard unavailable");
      await dashboard.save(getRequest(), data.organizationSlug, {
        ...(data.triggerId === undefined ? {} : { triggerId: data.triggerId }),
        yaml: data.yaml,
      });
      return respondOk({ state: "complete" });
    } catch (error) {
      return respondWithFailure(error, triggerContext("trigger.save", data.organizationSlug), {
        fallback: error instanceof Error ? error.message : "Hub couldn't save this trigger.",
        forbidden: "You don't have permission to manage triggers.",
        validation: error instanceof Error ? error.message : "This trigger is invalid.",
        conflict: "A trigger with this name already exists.",
      });
    }
  });

export const recreateSprite = createServerFn({ method: "POST" })
  .validator(scopeSchema.extend({ triggerId: z.string().uuid() }))
  .handler(async ({ data }): Promise<Result<{ state: "complete" }>> => {
    try {
      const dashboard = (await getApplication()).triggerDashboard;
      if (dashboard == null) throw new Error("trigger dashboard unavailable");
      await dashboard.recreateSprite(getRequest(), data.organizationSlug, data.triggerId);
      return respondOk({ state: "complete" });
    } catch (error) {
      return recreateSpriteFailure(error, data.organizationSlug);
    }
  });

const RECREATE_SPRITE_FAILURE =
  "Hub couldn't recreate this sprite. Reload its status before trying again.";

/**
 * Only `SpriteBusyError` has anything the reader can act on; a database, provider, or internal
 * error says the same fixed sentence rather than handing its own text to the browser.
 */
export function recreateSpriteFailure(error: unknown, organizationSlug: string): Err {
  return respondWithFailure(error, triggerContext("trigger.sprite.recreate", organizationSlug), {
    fallback: RECREATE_SPRITE_FAILURE,
    forbidden: "You don't have permission to manage triggers.",
    conflict: error instanceof Error ? error.message : RECREATE_SPRITE_FAILURE,
    notFound: "This trigger no longer exists.",
  });
}

export type TriggerSnapshot = Awaited<ReturnType<TriggerDashboard["snapshot"]>>;

function triggerContext(operation: string, organizationSlug: string) {
  return { operation, component: "triggers", organizationSlug } as const;
}
