import { Link } from "react-router-dom";
import type { TimelineStage } from "../api/control-tower-api.js";

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${status}`}>{status}</span>;
}

export function RunTimeline({
  stages,
  onSelect,
}: {
  stages: TimelineStage[];
  onSelect?: (stageId: string) => void;
}) {
  return (
    <div className="timeline">
      {stages.map((stage) => (
        <button
          key={stage.stageId}
          type="button"
          className="timeline-item"
          style={{ textAlign: "left", width: "100%" }}
          onClick={() => onSelect?.(stage.stageId)}
        >
          <strong>{stage.label}</strong>
          <span className="muted mono">{stage.stageId}</span>
          <StatusBadge status={stage.status} />
        </button>
      ))}
    </div>
  );
}

export function EvidenceViewer({
  title,
  evidence,
}: {
  title: string;
  evidence: unknown;
}) {
  if (evidence == null) {
    return (
      <div className="panel">
        <h3>{title}</h3>
        <p className="empty">No structured evidence.</p>
      </div>
    );
  }
  const obj = evidence as Record<string, unknown>;
  return (
    <div className="panel">
      <h3>{title}</h3>
      <table>
        <tbody>
          {Object.entries(obj)
            .filter(([k]) => !/secret|nonce|password|token/i.test(k))
            .slice(0, 40)
            .map(([key, value]) => (
              <tr key={key}>
                <th>{key}</th>
                <td className="mono">
                  {typeof value === "string" || typeof value === "number"
                    ? String(value)
                    : JSON.stringify(value)}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

export function ErrorPanel({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as {
    message?: string;
    code?: string;
    requestId?: string;
    status?: number;
  };
  return (
    <div className="error-box">
      <div>
        <strong>{e.code ?? "ERROR"}</strong>
        {e.status ? ` (${e.status})` : ""}
      </div>
      <div>{e.message ?? String(error)}</div>
      {e.requestId ? (
        <div className="mono" style={{ marginTop: 6 }}>
          requestId: {e.requestId}
        </div>
      ) : null}
    </div>
  );
}

export function RunsTable({
  runs,
}: {
  runs: Array<{
    runId: string;
    projectId: string;
    objectiveId: string;
    state: string;
    updatedAt: string;
  }>;
}) {
  if (runs.length === 0) {
    return <p className="empty">No runs.</p>;
  }
  return (
    <table>
      <thead>
        <tr>
          <th>Run</th>
          <th>Objective</th>
          <th>Project</th>
          <th>State</th>
          <th>Updated</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => (
          <tr key={run.runId}>
            <td className="mono">
              <Link to={`/runs/${run.runId}`}>{run.runId}</Link>
            </td>
            <td className="mono">{run.objectiveId}</td>
            <td className="mono">{run.projectId}</td>
            <td>
              <StatusBadge status={run.state} />
            </td>
            <td className="mono">{run.updatedAt}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
