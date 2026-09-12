import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { controlTowerApi, type Dashboard } from "../../api/control-tower-api.js";
import { ErrorPanel, RunsTable, StatusBadge } from "../../components/ui.js";
import { ApiClientError } from "../../api/client.js";

export function DashboardPage() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const dashboard = await controlTowerApi.dashboard();
        if (!cancelled) {
          setData(dashboard);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <p className="muted">Loading dashboard…</p>;
  if (error) return <ErrorPanel error={error instanceof ApiClientError ? error : error} />;
  if (!data) return <p className="empty">No dashboard data.</p>;

  const cards = [
    ["Active Runs", data.counts.active],
    ["Awaiting Approval", data.counts.awaitingApproval],
    ["Executing", data.counts.executing],
    ["Verification Required", data.counts.verifying],
    ["Completed", data.counts.completed],
    ["Blocked / Failed", data.counts.blockedOrFailed],
  ] as const;

  return (
    <div>
      <h2>Dashboard</h2>
      <p className="doctrine">{data.doctrine.controlTowerNotAuthority}</p>
      <div className="cards">
        {cards.map(([label, value]) => (
          <div className="card" key={label}>
            <div className="label">{label}</div>
            <div className="value">{value}</div>
          </div>
        ))}
      </div>
      <div className="panel">
        <h3>Recent Runs</h3>
        <RunsTable runs={data.recentRuns} />
      </div>
      <div className="panel">
        <h3>Recent Approval Requests</h3>
        {data.recentApprovals.length === 0 ? (
          <p className="empty">No pending approvals.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Approval</th>
                <th>Run</th>
                <th>Validation</th>
                <th>Expires</th>
              </tr>
            </thead>
            <tbody>
              {data.recentApprovals.map((a) => (
                <tr key={a.approvalRequestId}>
                  <td className="mono">
                    <Link to={`/approvals/${a.approvalRequestId}`}>
                      {a.approvalRequestId}
                    </Link>
                  </td>
                  <td className="mono">
                    <Link to={`/runs/${a.runId}`}>{a.runId}</Link>
                  </td>
                  <td>
                    <StatusBadge status={a.validationDecision} />
                  </td>
                  <td className="mono">{a.expiresAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="panel">
        <h3>Recent Completions</h3>
        {data.recentCompletions.length === 0 ? (
          <p className="empty">No completions.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Project</th>
                <th>Completed At</th>
              </tr>
            </thead>
            <tbody>
              {data.recentCompletions.map((c) => (
                <tr key={c.runId}>
                  <td className="mono">
                    <Link to={`/runs/${c.runId}`}>{c.runId}</Link>
                  </td>
                  <td className="mono">{c.projectId}</td>
                  <td className="mono">{c.completedAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
