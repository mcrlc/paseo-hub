import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { DataCell, DataRow, DataTable, DataTableSkeleton } from "../components/app/data-table.js";
import { FailureAlert } from "../components/app/failure-alert.js";
import { PageHeader } from "../components/app/page.js";
import { RelativeTime } from "../components/app/relative-time.js";
import { StatusPill, statusLabel } from "../components/app/status-pill.js";
import { TwoLine } from "../components/app/two-line.js";
import { machineTone } from "../daemons/sprites/machine-status.js";
import { useRouteTenant } from "../projects/context.js";
import { triggerSnapshot, type TriggerSnapshot } from "./functions.js";

export type ActivityRun = TriggerSnapshot["activity"][number];

const ACTIVITY_COLUMNS = [
  { header: "Trigger" },
  { header: "Provider" },
  { header: "Source" },
  { header: "Status" },
  { header: "Received" },
];
const EMPTY_ACTIVITY = { title: "No activity" };
const ACTIVITY_DESCRIPTION = "Agent runs launched by organization triggers.";

export function TriggerActivityPanel() {
  const tenant = useRouteTenant();
  const load = useServerFn(triggerSnapshot);
  const organizationSlug = tenant.organization.slug;
  const snapshot = useQuery({
    queryKey: ["triggers", organizationSlug],
    queryFn: () => load({ data: { organizationSlug } }),
  });
  if (snapshot.isPending) {
    return (
      <>
        <PageHeader title="Activity" description={ACTIVITY_DESCRIPTION} />
        <DataTableSkeleton label="Trigger activity" columns={ACTIVITY_COLUMNS} />
      </>
    );
  }
  if (snapshot.isError || snapshot.data.status === "error") {
    return (
      <FailureAlert
        title="Activity unavailable"
        error={snapshot.data}
        fallback="Hub couldn't load trigger activity."
      />
    );
  }
  const activity = snapshot.data.data.activity;
  return (
    <>
      <PageHeader title="Activity" description={ACTIVITY_DESCRIPTION} />
      <DataTable
        label="Trigger activity"
        columns={ACTIVITY_COLUMNS}
        isEmpty={activity.length === 0}
        empty={EMPTY_ACTIVITY}
      >
        {activity.map((run) => (
          <ActivityRow key={run.id} run={run} />
        ))}
      </DataTable>
    </>
  );
}

export function ActivityRow({ run }: { run: ActivityRun }) {
  return (
    <DataRow>
      <DataCell>
        <TwoLine
          primary={run.triggerName}
          {...(run.repo === null ? {} : { secondary: run.repo })}
        />
      </DataCell>
      <DataCell>{run.provider}</DataCell>
      <DataCell>{run.source}</DataCell>
      <DataCell>
        <span className="inline-flex items-center gap-1.5">
          <StatusPill tone={tone(run.status)}>{statusLabel(run.status)}</StatusPill>
          {run.machineStatus === null ? null : (
            <StatusPill tone={machineTone(run.machineStatus)}>
              {statusLabel(run.machineStatus)}
            </StatusPill>
          )}
        </span>
      </DataCell>
      <DataCell muted>
        <RelativeTime value={run.receivedAt} />
      </DataCell>
    </DataRow>
  );
}

function tone(status: string): "success" | "danger" | "neutral" {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "timed_out" || status === "rejected") return "danger";
  return "neutral";
}
