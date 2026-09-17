import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import { DataTable, type DataColumn } from "../components/app/data-table.js";
import { canRenameDaemon, DaemonRow } from "./account-daemons.js";
import type { BrowserDaemon } from "./functions.js";

const COLUMNS: readonly DataColumn[] = [
  { header: "Slug" },
  { header: "Status" },
  { header: "", align: "end" },
];

const DAEMON: BrowserDaemon = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "devbox",
  status: "active",
  presence: "connected",
  connectedAt: "2026-09-17T09:00:00.000Z",
  lastSeenAt: "2026-09-17T09:30:00.000Z",
  registeredAt: "2026-09-16T09:00:00.000Z",
  permissions: ["hub.execute"],
  sprite: null,
};

const SPRITE: BrowserDaemon = {
  ...DAEMON,
  slug: "pr-reviewer",
  sprite: { triggerName: "pr-reviewer", machineStatus: "alive" },
};

const ignore = () => undefined;
const noRename = () => Promise.resolve(undefined);
const EMPTY = { title: "No daemons" };

function row(daemon: BrowserDaemon): string {
  return renderToStaticMarkup(
    <DataTable label="Daemons" columns={COLUMNS} isEmpty={false} empty={EMPTY}>
      <DaemonRow daemon={daemon} canManage busy={false} onRename={noRename} onRevoke={ignore} />
    </DataTable>,
  );
}

describe("daemon row", () => {
  it("names the owning trigger and the sprite's machine status", () => {
    const html = row(SPRITE);

    assert.match(html, />pr-reviewer</u);
    assert.match(html, />Alive</u);
    assert.match(html, />Connected</u);
  });

  it("says nothing about a sprite for a daemon somebody enrolled by hand", () => {
    const html = row(DAEMON);

    assert.doesNotMatch(html, /Alive|Spawning|Terminated/u);
  });

  it.each([
    ["spawning", "Spawning"],
    ["terminated", "Terminated"],
  ] as const)("reads machine status %s as a pill", (machineStatus, label) => {
    assert.match(
      row({ ...SPRITE, sprite: { triggerName: "pr-reviewer", machineStatus } }),
      new RegExp(`>${label}<`, "u"),
    );
  });

  it("refuses to rename a sprite daemon, whose slug is its trigger's name", () => {
    assert.equal(canRenameDaemon(SPRITE), false);
    assert.equal(canRenameDaemon(DAEMON), true);
  });
});
