import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import {
  controlTowerApi,
  type PublicApproval,
} from "../../api/control-tower-api.js";
import { ApiClientError, getPrincipalId } from "../../api/client.js";
import { ErrorPanel, EvidenceViewer, StatusBadge } from "../../components/ui.js";

export function ApprovalInboxPage() {
  const [approvals, setApprovals] = useState<PublicApproval[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void controlTowerApi
      .listApprovals()
      .then((res) => {
        if (!cancelled) setApprovals(res.approvals);
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

  if (loading) return <p className="muted">Loading approvals…</p>;
  if (error) return <ErrorPanel error={error} />;
  return (
    <div>
      <h2>Approval Inbox</h2>
      <p className="doctrine">PASS ≠ APPROVED</p>
      <div className="panel">
        {approvals.length === 0 ? (
          <p className="empty">No pending approval requests.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Approval</th>
                <th>Objective</th>
                <th>Plan</th>
                <th>Validation</th>
                <th>Expires</th>
              </tr>
            </thead>
            <tbody>
              {approvals.map((a) => (
                <tr key={a.approvalRequestId}>
                  <td className="mono">
                    <Link to={`/approvals/${a.approvalRequestId}`}>
                      {a.approvalRequestId}
                    </Link>
                  </td>
                  <td className="mono">{a.objectiveId}</td>
                  <td className="mono">
                    {a.planId}@{a.planVersion}
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
    </div>
  );
}

export function ApprovalDecisionPage() {
  const { approvalRequestId = "" } = useParams();
  const [detail, setDetail] = useState<{
    request: PublicApproval;
    decisionCard: unknown;
    doctrine: Record<string, string>;
  } | null>(null);
  /** Ephemeral only — never persist nonce to storage/URL/logs. */
  const [nonce, setNonce] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await controlTowerApi.getApproval(approvalRequestId);
        if (!cancelled) setDetail(next);
        try {
          const delivery = await controlTowerApi.localDelivery(approvalRequestId);
          if (!cancelled) setNonce(delivery.decisionNonce);
        } catch {
          // Production / disabled: nonce arrives out-of-band into component memory only.
        }
      } catch (err) {
        if (!cancelled) setError(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      setNonce("");
    };
  }, [approvalRequestId]);

  const decide = async (
    event: FormEvent,
    decision: "APPROVE" | "REJECT" | "REQUEST_MODIFICATION",
  ) => {
    event.preventDefault();
    setError(null);
    setResult(null);
    const nonceForRequest = nonce;
    try {
      const response = await controlTowerApi.decide(approvalRequestId, {
        approverId: getPrincipalId(),
        decision,
        submittedAt: new Date().toISOString(),
        decisionNonce: nonceForRequest,
        ...(note ? { note } : {}),
      });
      setResult(response);
    } catch (err) {
      setError(err instanceof ApiClientError ? err : err);
    } finally {
      // Discard nonce after attempt — do not retain in storage.
      setNonce("");
    }
  };

  if (loading) return <p className="muted">Loading approval…</p>;
  if (error && !detail) return <ErrorPanel error={error} />;
  if (!detail) return <p className="empty">Approval not found.</p>;

  return (
    <div>
      <h2>Approval Decision</h2>
      <p className="doctrine">{detail.doctrine.passNotApproved}</p>
      <p className="doctrine">{detail.doctrine.controlTowerNotAuthority}</p>
      <ErrorPanel error={error} />
      <div className="panel">
        <table>
          <tbody>
            <tr>
              <th>Approval</th>
              <td className="mono">{detail.request.approvalRequestId}</td>
            </tr>
            <tr>
              <th>Run</th>
              <td className="mono">
                <Link to={`/runs/${detail.request.runId}`}>
                  {detail.request.runId}
                </Link>
              </td>
            </tr>
            <tr>
              <th>Plan</th>
              <td className="mono">
                {detail.request.planId} v{detail.request.planVersion} /{" "}
                {detail.request.planHash}
              </td>
            </tr>
            <tr>
              <th>Validation</th>
              <td>
                <StatusBadge status={detail.request.validationDecision} />
              </td>
            </tr>
            <tr>
              <th>Expires</th>
              <td className="mono">{detail.request.expiresAt}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <EvidenceViewer title="Decision Card" evidence={detail.decisionCard} />
      <form className="panel">
        <div className="field">
          <label htmlFor="nonce">Decision nonce (from delivery channel)</label>
          <input
            id="nonce"
            className="mono"
            value={nonce}
            onChange={(e) => setNonce(e.target.value)}
            required
          />
          <span className="muted">
            Held only in component memory. Never written to sessionStorage,
            localStorage, IndexedDB, or the URL. Cleared after decide.
            Local fake delivery may prefill in DEVELOPMENT only.
          </span>
        </div>
        <div className="field">
          <label htmlFor="note">Note (optional)</label>
          <textarea
            id="note"
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" onClick={(e) => void decide(e, "APPROVE")}>
            Approve
          </button>
          <button
            type="button"
            className="danger"
            onClick={(e) => void decide(e, "REJECT")}
          >
            Reject
          </button>
          <button
            type="button"
            className="secondary"
            onClick={(e) => void decide(e, "REQUEST_MODIFICATION")}
          >
            Request Modification
          </button>
        </div>
      </form>
      {result ? (
        <EvidenceViewer title="Server decision result" evidence={result} />
      ) : null}
    </div>
  );
}
