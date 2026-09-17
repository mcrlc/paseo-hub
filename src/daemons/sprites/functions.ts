import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { respondOk, type Result } from "../../contract/respond.js";
import { respondWithFailure } from "../../failures/index.js";
import { getApplication } from "../../server/runtime.js";
import type { SpritesSettingsSnapshot } from "./settings.js";

const scopeSchema = z.object({ organizationSlug: z.string().trim().min(1).max(100) });
const saveSchema = scopeSchema.extend({
  token: z.string().trim().min(1),
  memoryMb: z.number().int().positive().default(8192),
});

export const spritesSettingsSnapshot = createServerFn({ method: "GET" })
  .validator(scopeSchema)
  .handler(async ({ data }): Promise<Result<SpritesSettingsSnapshot>> => {
    try {
      const settings = (await getApplication()).spritesSettings;
      if (settings == null) throw new Error("sprites settings unavailable");
      return respondOk(await settings.snapshot(getRequest(), data.organizationSlug));
    } catch (error) {
      return respondWithFailure(error, spritesContext("sprites.settings", data.organizationSlug), {
        fallback: "Hub couldn't load the Sprites configuration. Reload the page.",
        forbidden: "You don't have permission to configure Sprites.",
      });
    }
  });

export const saveSpritesSettings = createServerFn({ method: "POST" })
  .validator(saveSchema)
  .handler(async ({ data }): Promise<Result<SpritesSaveOutcome>> => {
    try {
      const settings = (await getApplication()).spritesSettings;
      if (settings == null) throw new Error("sprites settings unavailable");
      await settings.save(getRequest(), data.organizationSlug, {
        token: data.token,
        memoryMb: data.memoryMb,
      });
      return respondOk({ state: "complete" });
    } catch (error) {
      const name = error instanceof Error ? error.name : undefined;
      if (name === "SpritesTokenRejectedError") {
        return respondOk({ state: "invalid", errors: { token: "Sprites rejected this token." } });
      }
      return respondWithFailure(error, spritesContext("sprites.save", data.organizationSlug), {
        fallback:
          name === "SpritesTokenCheckError" && error instanceof Error
            ? error.message
            : "Hub couldn't save the Sprites configuration. The stored token is unchanged.",
        forbidden: "You don't have permission to configure Sprites.",
      });
    }
  });

const setEnvSchema = scopeSchema.extend({ key: z.string(), value: z.string() });
const removeEnvSchema = scopeSchema.extend({ key: z.string() });

export const setSpritesEnv = createServerFn({ method: "POST" })
  .validator(setEnvSchema)
  .handler(async ({ data }): Promise<Result<{ state: "complete" }>> => {
    try {
      const settings = (await getApplication()).spritesSettings;
      if (settings == null) throw new Error("sprites settings unavailable");
      await settings.setEnv(getRequest(), data.organizationSlug, {
        key: data.key,
        value: data.value,
      });
      return respondOk({ state: "complete" });
    } catch (error) {
      return respondWithFailure(error, spritesContext("sprites.env.set", data.organizationSlug), {
        fallback: "Hub couldn't save the variable. The stored environment is unchanged.",
        forbidden: "You don't have permission to configure Sprites.",
        ...(error instanceof Error && error.name === "SpritesEnvInputError"
          ? { validation: error.message }
          : {}),
      });
    }
  });

export const removeSpritesEnv = createServerFn({ method: "POST" })
  .validator(removeEnvSchema)
  .handler(async ({ data }): Promise<Result<{ state: "complete" }>> => {
    try {
      const settings = (await getApplication()).spritesSettings;
      if (settings == null) throw new Error("sprites settings unavailable");
      await settings.removeEnv(getRequest(), data.organizationSlug, { key: data.key });
      return respondOk({ state: "complete" });
    } catch (error) {
      return respondWithFailure(
        error,
        spritesContext("sprites.env.remove", data.organizationSlug),
        {
          fallback:
            "Hub couldn't remove the variable. Reload the page to check whether it is gone.",
          forbidden: "You don't have permission to configure Sprites.",
        },
      );
    }
  });

export type SpritesSaveOutcome =
  | { state: "complete" }
  | { state: "invalid"; errors: { token: string } };

function spritesContext(operation: string, organizationSlug: string) {
  return { operation, component: "sprites", organizationSlug } as const;
}
