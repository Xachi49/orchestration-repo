import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  controlTowerApi,
  type RunDetail,
  type RunRecord,
} from "../../api/control-tower-api.js";
import {
  ErrorPanel,
  EvidenceViewer,
  RunTimeline,
  RunsTable,
  StatusBadge,
} from "../../components/ui.js";
import { ApiClientError } from "../../api/client.js";

export function RunsListPage() {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void controlTowerApi
      .listRuns()
      .then((res) => {
        if (!cancelled) setRuns(res.runs);
      })
      .catch((err) => {
        if (!cancelled) setError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <p className="muted">Loading runs…</p>;
  if (error) return <ErrorPanel error={error} />;
  return (
    <div>
      <h2>Runs</h2>
      <div className="panel">
        <RunsTable runs={runs} />
      </div>
    </div>
  );
}

export function RunDetailPage() {
  const { runId = "" } = useParams();
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [selected, setSelected] = useState<string>("VALIDATION");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = await controlTowerApi.getRun(runId);
        if (!cancelled) {
          setDetail(next);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const terminal = new Set([
      "COMPLETED",
      "FAILED",
      "REJECTED",
      "CANCELLED",
      "EXPIRED",
      "ADMISSION_REJECTED",
      "CONTAINED",
    ]);
    const id = setInterval(() => {
      if (detail && terminal.has(detail.run.state)) return;
      void load();
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [runId, detail?.run.state]);

  if (loading && !detail) return <p className="muted">Loading run…</p>;
  if (error && !detail) {
    return <ErrorPanel error={error instanceof ApiClientError ? error : error} />;
  }
  if (!detail) return <p className="empty">Run not found.</p>;

  const evidenceForStage: Record<string, unknown> = {
    ADMISSION: detail.objective,
    REPOSITORY_TRUTH: detail.repositoryContext,
    PLANNING: detail.plan,
    VALIDATION: detail.validation,
    AUTHORIZATION: detail.approvalRequest ?? detail.authorization,
    EXECUTION: detail.execution,
    VERIFICATION: detail.verification,
    COMPLETION: detail.completion,
  };

  return (
    <div>
      <h2>Run Detail</h2>
      <div className="panel">
        <div className="cards">
          <div className="card">
            <div className="label">Run ID</div>
            <div className="mono">{detail.run.runId}</div>
          </div>
          <div className="card">
            <div className="label">Objective</div>
            <div className="mono">{detail.run.objectiveId}</div>
          </div>
          <div className="card">
            <div className="label">Project</div>
            <div className="mono">{detail.run.projectId}</div>
          </div>
          <div className="card">
            <div className="label">Environment</div>
            <div className="mono">{detail.run.requestedEnvironment}</div>
          </div>
          <div className="card">
            <div className="label">State</div>
            <div>
              <StatusBadge status={detail.run.state} />
            </div>
          </div>
          <div className="card">
            <div className="label">Created</div>
            <div className="mono">{detail.run.createdAt}</div>
          </div>
        </div>
        <p className="doctrine">{detail.doctrine.passNotApproved}</p>
        <p className="doctrine">{detail.doctrine.executionSucceededNotVerified}</p>
        <p className="doctrine">{detail.doctrine.verifiedSuccessNotCompleted}</p>
        {detail.run.state === "AWAITING_APPROVAL" && detail.approvalRequest ? (
          <p>
            <Link
              to={`/approvals/${(detail.approvalRequest as { approvalRequestId: string }).approvalRequestId}`}
            >
              Open approval decision
            </Link>
          </p>
        ) : null}
      </div>
      <div className="panel">
        <h3>Lifecycle Timeline</h3>
        <RunTimeline stages={detail.timeline} onSelect={setSelected} />
      </div>
      <EvidenceViewer
        title={`Stage evidence: ${selected}`}
        evidence={evidenceForStage[selected]}
      />
    </div>
  );
}
