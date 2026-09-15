import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { controlTowerApi } from "../../api/control-tower-api.js";
import { ErrorPanel, StatusBadge } from "../../components/ui.js";

const DEFAULT_CUSTOMER = "continuum_demo_tenant";
const DEFAULT_PROJECT = "discord-scale-architect";

export function RevenueRecoveryDashboardPage() {
  const [data, setData] = useState<Awaited<
    ReturnType<typeof controlTowerApi.revenueRecoveryDashboard>
  > | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    void controlTowerApi
      .revenueRecoveryDashboard(DEFAULT_CUSTOMER, DEFAULT_PROJECT)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <ErrorPanel error={error} />;
  if (!data) return <p className="muted">Loading revenue recovery…</p>;

  const f = data.funnel;
  return (
    <div>
      <h2>Revenue Recovery</h2>
      <p className="doctrine">{data.doctrine.gapNotAuthorization}</p>
      <p className="doctrine">{data.doctrine.estimatedNotBooked}</p>
      <p className="doctrine">{data.doctrine.bookedNotCollected}</p>
      <p className="doctrine">{data.doctrine.attestedNotConfirmed}</p>
      <div className="panel">
        <h3>Recovery Funnel</h3>
        <table>
          <tbody>
            <tr>
              <th>Open Recovery Cases</th>
              <td>{f.openRecoveryCases}</td>
            </tr>
            <tr>
              <th>Awaiting Approval</th>
              <td>{f.casesAwaitingApproval}</td>
            </tr>
            <tr>
              <th>Engaged Leads</th>
              <td>{f.engagedLeads}</td>
            </tr>
            <tr>
              <th>Appointments Recovered</th>
              <td>{f.appointmentsRecovered}</td>
            </tr>
            <tr>
              <th>Estimated Pipeline</th>
              <td className="mono">{f.estimatedPipelineRecovered}</td>
            </tr>
            <tr>
              <th>Booked Recovered Revenue</th>
              <td className="mono">{f.bookedRecoveredRevenue}</td>
            </tr>
            <tr>
              <th>Confirmed Collected Revenue</th>
              <td className="mono">{f.confirmedRecoveredRevenue}</td>
            </tr>
            <tr>
              <th>Operator Attested (not confirmed)</th>
              <td className="mono">{f.operatorAttestedRevenue}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="panel">
        <h3>Cases</h3>
        {data.cases.length === 0 ? (
          <p className="empty">No recovery cases.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Case</th>
                <th>Status</th>
                <th>Estimated</th>
                <th>Gap</th>
              </tr>
            </thead>
            <tbody>
              {data.cases.map((c) => (
                <tr key={c.recoveryCaseId}>
                  <td className="mono">
                    <Link to={`/revenue-recovery/cases/${c.recoveryCaseId}`}>
                      {c.recoveryCaseId}
                    </Link>
                  </td>
                  <td>
                    <StatusBadge status={c.status} />
                  </td>
                  <td className="mono">
                    {c.estimatedRecoverableValue ?? "—"} {c.currency ?? ""}
                  </td>
                  <td className="mono">{c.gapDetectedAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export function RevenueRecoveryCasePage() {
  const { recoveryCaseId = "" } = useParams();
  const [data, setData] = useState<Awaited<
    ReturnType<typeof controlTowerApi.revenueRecoveryCase>
  > | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    void controlTowerApi
      .revenueRecoveryCase(recoveryCaseId, DEFAULT_CUSTOMER, DEFAULT_PROJECT)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e);
      });
    return () => {
      cancelled = true;
    };
  }, [recoveryCaseId]);

  if (error) return <ErrorPanel error={error} />;
  if (!data) return <p className="muted">Loading case…</p>;

  return (
    <div>
      <h2>Recovery Case</h2>
      <p className="doctrine">{data.doctrine.gapNotAuthorization}</p>
      <div className="panel">
        <table>
          <tbody>
            <tr>
              <th>Case</th>
              <td className="mono">{data.recoveryCase.recoveryCaseId}</td>
            </tr>
            <tr>
              <th>Status</th>
              <td>
                <StatusBadge status={data.recoveryCase.status} />
              </td>
            </tr>
            <tr>
              <th>Lead</th>
              <td className="mono">{data.lead.leadId}</td>
            </tr>
            <tr>
              <th>Service</th>
              <td>{data.lead.serviceRequested ?? "—"}</td>
            </tr>
            <tr>
              <th>Phone (masked)</th>
              <td className="mono">{data.lead.phoneMasked ?? "—"}</td>
            </tr>
            <tr>
              <th>Email (masked)</th>
              <td className="mono">{data.lead.emailMasked ?? "—"}</td>
            </tr>
            <tr>
              <th>Estimated Recoverable</th>
              <td className="mono" data-testid="estimated-revenue">
                {data.economics.estimatedRecoverableValue ?? "—"}{" "}
                {data.economics.currency}
              </td>
            </tr>
            <tr>
              <th>Booked Recovered</th>
              <td className="mono" data-testid="booked-revenue">
                {data.economics.bookedRecoveredRevenue ?? "—"}{" "}
                {data.economics.currency}
              </td>
            </tr>
            <tr>
              <th>Collected Recovered</th>
              <td className="mono" data-testid="collected-revenue">
                {data.economics.confirmedCollectedRevenue ?? "—"}{" "}
                {data.economics.currency}
              </td>
            </tr>
            <tr>
              <th>Operator Attested</th>
              <td className="mono" data-testid="attested-revenue">
                {data.economics.operatorAttestedRevenue ?? "—"}{" "}
                {data.economics.currency}
              </td>
            </tr>
            <tr>
              <th>Orchestrator Run</th>
              <td className="mono">
                {data.recoveryCase.orchestratorRunId ? (
                  <Link to={`/runs/${data.recoveryCase.orchestratorRunId}`}>
                    {data.recoveryCase.orchestratorRunId}
                  </Link>
                ) : (
                  "—"
                )}
              </td>
            </tr>
            <tr>
              <th>Contact eligible</th>
              <td>{data.contactPolicy.eligible ? "YES" : "NO"}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="panel">
        <h3>Attempts</h3>
        {data.attempts.length === 0 ? (
          <p className="empty">No outreach attempts.</p>
        ) : (
          <ul>
            {data.attempts.map((a) => (
              <li key={a.attemptId} className="mono">
                {a.channel} @ {a.sentAt} → {a.deliveryOutcome}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
