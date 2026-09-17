import { createFileRoute } from "@tanstack/react-router";
import { SpritesSettingsPanel } from "../../../../../daemons/sprites/panel.js";

export const Route = createFileRoute("/_shell/o/$organizationSlug/settings/sprites")({
  staticData: { breadcrumb: "Sprites" },
  component: SpritesSettingsPanel,
});
