import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import { DataTable, type DataColumn } from "../components/app/data-table.js";
import { ActivityRow, type ActivityRun } from "./activity-panel.js";

const COLUMNS: readonly DataColumn[] = [{ header: "Trigger" }, { header: "Status" }];

const EMPTY = { title: "None" };

const RUN: ActivityRun = {
  id: "33333333-3333-4333-8333-333333333333",
  triggerId: "44444444-4444-4444-8444-444444444444",
  triggerName: "reviewer",
  provider: "github",
  source: "github.issue_comment",
  repo: "acme/hub",
  status: "running",
  receivedAt: "2026-09-17T09:00:00.000Z",
  machineStatus: null,
};

function row(run: ActivityRun): string {
  return renderToStaticMarkup(
    <DataTable label="Trigger activity" columns={COLUMNS} isEmpty={false} empty={EMPTY}>
      <ActivityRow run={run} />
    </DataTable>,
  );
}

describe("activity row", () => {
  it("shows the sprite's machine status beside the run's own status", () => {
    const html = row({ ...RUN, machineStatus: "alive" });

    assert.match(html, />Running</u);
    assert.match(html, />Alive</u);
  });

  it("says nothing about a machine for a run that did not go to a sprite", () => {
    assert.doesNotMatch(row(RUN), />Alive|>Spawning|>Terminated/u);
  });
});
