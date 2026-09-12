import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { controlTowerApi } from "../../api/control-tower-api.js";
import { ErrorPanel, EvidenceViewer } from "../../components/ui.js";

export function EvidencePage() {
  const [runId, setRunId] = useState("");
  const [evidence, setEvidence] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = async () => {
    setError(null);
    try {
      setEvidence(await controlTowerApi.getEvidence(runId));
    } catch (err) {
      setError(err);
      setEvidence(null);
    }
  };

  return (
    <div>
      <h2>Evidence</h2>
      <p className="muted">Structured evidence only — no hidden reasoning.</p>
      <div className="panel" style={{ display: "flex", gap: 8 }}>
        <input
          className="mono"
          placeholder="runId"
          value={runId}
          onChange={(e) => setRunId(e.target.value)}
        />
        <button type="button" onClick={() => void load()} disabled={!runId}>
          Load
        </button>
      </div>
      <ErrorPanel error={error} />
      {evidence ? (
        <>
          <p>
            <Link to={`/runs/${runId}`}>Open run</Link>
          </p>
          <EvidenceViewer title="Validation" evidence={evidence.validation} />
          <EvidenceViewer title="Verification" evidence={evidence.verification} />
          <EvidenceViewer title="CompletionRecord" evidence={evidence.completion} />
          <EvidenceViewer
            title="Repository Context"
            evidence={evidence.repositoryContext}
          />
          <EvidenceViewer title="Plan binding" evidence={evidence.plan} />
        </>
      ) : (
        <p className="empty">Enter a run ID to inspect evidence.</p>
      )}
    </div>
  );
}

export function AssurancePage() {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    void controlTowerApi
      .assurance()
      .then(setData)
      .catch(setError);
  }, []);
  return (
    <div>
      <h2>System Assurance</h2>
      <p className="doctrine">CERTIFICATE ≠ OPERATIONAL AUTHORITY</p>
      <ErrorPanel error={error} />
      <EvidenceViewer title="Assurance snapshot" evidence={data} />
      <p className="muted">
        Status vocabulary: VALID / STALE / EXPIRED / REVOKED — via assurance
        certificate routes when mounted.
      </p>
    </div>
  );
}

export function QualificationPage() {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    void controlTowerApi
      .qualification()
      .then(setData)
      .catch(setError);
  }, []);
  return (
    <div>
      <h2>Release Qualification</h2>
      <p className="doctrine">QUALIFIED_FOR_RELEASE ≠ DEPLOYED</p>
      <p className="doctrine">DEPLOYMENT ≠ IN SCOPE</p>
      <ErrorPanel error={error} />
      <EvidenceViewer title="Qualification snapshot" evidence={data} />
      <p className="muted">No Deploy button. Qualification never authorizes deployment.</p>
    </div>
  );
}

export function GovernancePage() {
  return (
    <div>
      <h2>Governance</h2>
      <p className="muted">MVP read-only placeholder.</p>
      <div className="panel">
        <p>Institution / Mandates / Delegations / Holds / Proof status</p>
        <p className="doctrine">Use canonical /v1/governance/* routes for detail.</p>
      </div>
    </div>
  );
}

export function FederationPage() {
  return (
    <div>
      <h2>Federation</h2>
      <p className="muted">MVP read-only placeholder.</p>
      <div className="panel">
        <p>Agreements / Participants / Intents / Acceptance lineage</p>
        <p className="doctrine">
          FEDERATION_AGREEMENT ≠ LOCAL_AUTHORITY — use /v1/federations/* routes.
        </p>
      </div>
    </div>
  );
}
