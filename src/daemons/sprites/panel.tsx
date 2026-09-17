import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useMemo, useState, type FormEvent } from "react";
import { Card, CardSkeleton } from "../../components/app/card.js";
import { EmptyState } from "../../components/app/empty-state.js";
import { FailureAlert, NoticeAlert, type Failure } from "../../components/app/failure-alert.js";
import { FormActions } from "../../components/app/form-actions.js";
import { FormField } from "../../components/app/form-field.js";
import { PageHeader, PageHeaderSkeleton } from "../../components/app/page.js";
import { RelativeTime } from "../../components/app/relative-time.js";
import { Section } from "../../components/app/section.js";
import { SummaryPanel } from "../../components/app/summary-panel.js";
import { Button } from "../../components/ui/button.js";
import type { Result } from "../../contract/respond.js";
import { useRouteTenant } from "../../projects/context.js";
import {
  saveSpritesSettings,
  spritesSettingsSnapshot,
  type SpritesSaveOutcome,
} from "./functions.js";
import type { SpritesSettingsSnapshot } from "./settings.js";

const DEFAULT_MEMORY_MB = 8192;
const TITLE = "Sprites";
const LOAD_FAILURE =
  "Hub did not receive the Sprites configuration. Check your connection and reload the page.";
const SAVE_FAILURE =
  "Hub did not receive the save result. Reload the page to check whether the token was stored.";

const CONFIGURED = { label: "Configured", tone: "success" } as const;
const NOT_CONFIGURED = { label: "Not configured", tone: "neutral" } as const;

type FieldErrors = Partial<Record<"token" | "memoryMb", string>>;

export function SpritesSettingsPanel() {
  const tenant = useRouteTenant();
  const queryClient = useQueryClient();
  const organizationSlug = tenant.organization.slug;
  const queryKey = ["sprites-settings", tenant.organization.id];
  const load = useServerFn(spritesSettingsSnapshot) as (
    input: Parameters<typeof spritesSettingsSnapshot>[0],
  ) => Promise<Result<SpritesSettingsSnapshot>>;
  const snapshot = useQuery({
    queryKey,
    queryFn: () => load({ data: { organizationSlug } }),
    enabled: tenant.capabilities.manageResources,
  });
  const save = useMutation({
    mutationFn: useServerFn(saveSpritesSettings) as (
      input: Parameters<typeof saveSpritesSettings>[0],
    ) => Promise<Result<SpritesSaveOutcome>>,
    onSuccess: async (result) => {
      if (result.status === "ok" && result.data.state === "complete")
        await queryClient.invalidateQueries({ queryKey });
    },
  });
  const onSave = useCallback(
    (values: { token: string; memoryMb: number }) =>
      save.mutate({ data: { organizationSlug, ...values } }),
    [organizationSlug, save],
  );
  const reset = useCallback(() => save.reset(), [save]);
  const reload = useCallback(() => void snapshot.refetch(), [snapshot]);
  const description = `The Fly Sprites organization token Hub uses to create sprites for ${tenant.organization.name}.`;

  if (!tenant.capabilities.manageResources) {
    return (
      <>
        <PageHeader title={TITLE} description={description} />
        <EmptyState
          title="No access to Sprites"
          description="You don't have permission to configure Sprites."
        />
      </>
    );
  }
  if (snapshot.isPending) {
    return (
      <>
        <PageHeaderSkeleton description={description} />
        <CardSkeleton />
      </>
    );
  }
  if (snapshot.isError || snapshot.data.status === "error") {
    return (
      <>
        <PageHeader title={TITLE} description={description} />
        <FailureAlert
          title="Sprites configuration unavailable"
          error={snapshot.data}
          fallback={LOAD_FAILURE}
          onRetry={reload}
        />
      </>
    );
  }
  const saveError =
    save.isError || save.data?.status === "error" ? (save.data ?? SAVE_FAILURE) : undefined;
  return (
    <>
      <PageHeader
        title={TITLE}
        description={description}
        status={snapshot.data.data.configured ? CONFIGURED : NOT_CONFIGURED}
      />
      <SpritesSettingsContent
        snapshot={snapshot.data.data}
        busy={save.isPending}
        saved={save.data?.status === "ok" && save.data.data.state === "complete"}
        error={saveError}
        {...(save.data?.status === "ok" && save.data.data.state === "invalid"
          ? { serverErrors: save.data.data.errors }
          : {})}
        onReset={reset}
        onSave={onSave}
      />
    </>
  );
}

export function SpritesSettingsContent({
  snapshot,
  busy,
  saved,
  error,
  serverErrors,
  onReset,
  onSave,
}: {
  snapshot: SpritesSettingsSnapshot;
  busy: boolean;
  saved: boolean;
  error: Failure;
  serverErrors?: FieldErrors;
  onReset: () => void;
  onSave: (values: { token: string; memoryMb: number }) => void;
}) {
  const [localErrors, setErrors] = useState<FieldErrors>({});
  const errors = { ...serverErrors, ...localErrors };
  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setErrors(submitSpritesForm(new FormData(event.currentTarget), onReset, onSave));
    },
    [onReset, onSave],
  );
  const summary = useMemo(
    () =>
      snapshot.updatedAt === null
        ? null
        : [
            { label: "Default memory", value: `${snapshot.memoryMb} MB` },
            { label: "Updated", value: <RelativeTime value={snapshot.updatedAt} /> },
          ],
    [snapshot.memoryMb, snapshot.updatedAt],
  );
  return (
    <>
      {summary === null ? null : (
        <Section>
          <SummaryPanel label="Sprites configuration" rows={summary} />
        </Section>
      )}
      <Card
        title={snapshot.configured ? "Replace token" : "Connect Sprites"}
        description="The token is stored write-only. Hub never shows it again."
      >
        <form
          key={snapshot.updatedAt ?? "unconfigured"}
          aria-label="Sprites configuration"
          noValidate
          onSubmit={submit}
          className="grid gap-4"
        >
          {saved ? <NoticeAlert tone="success">Sprites configuration saved.</NoticeAlert> : null}
          {error === undefined ? null : (
            <FailureAlert title="Configuration not saved" error={error} fallback={SAVE_FAILURE} />
          )}
          <FormField
            id="sprites-token"
            name="token"
            kind="secret"
            label={snapshot.configured ? "New token (replaces the stored token)" : "Token"}
            required
            disabled={busy}
            {...(errors.token === undefined ? {} : { error: errors.token })}
          />
          <FormField
            id="sprites-memory"
            name="memoryMb"
            kind="number"
            label="Default memory (MB)"
            description="Memory limit for each sprite unless its trigger sets one."
            required
            min={1}
            step={1}
            inputMode="numeric"
            defaultValue={String(snapshot.memoryMb ?? DEFAULT_MEMORY_MB)}
            disabled={busy}
            {...(errors.memoryMb === undefined ? {} : { error: errors.memoryMb })}
          />
          <FormActions>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </FormActions>
        </form>
      </Card>
    </>
  );
}

export function submitSpritesForm(
  form: FormData,
  reset: () => void,
  save: (values: { token: string; memoryMb: number }) => void,
): FieldErrors {
  reset();
  const { values, errors } = spritesFormValues(form);
  if (values !== undefined) save(values);
  return errors;
}

export function spritesFormValues(form: FormData): {
  values?: { token: string; memoryMb: number };
  errors: FieldErrors;
} {
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value.trim() : "";
  };
  const token = text("token");
  const memoryText = text("memoryMb");
  const memoryMb = memoryText === "" ? DEFAULT_MEMORY_MB : Number(memoryText);
  const errors: FieldErrors = {
    ...(token === "" ? { token: "Enter the Sprites organization token." } : {}),
    ...(Number.isInteger(memoryMb) && memoryMb > 0
      ? {}
      : { memoryMb: "Enter a whole number of megabytes above zero." }),
  };
  return Object.keys(errors).length === 0 ? { values: { token, memoryMb }, errors } : { errors };
}
