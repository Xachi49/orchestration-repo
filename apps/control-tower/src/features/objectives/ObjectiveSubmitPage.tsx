import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { controlTowerApi } from "../../api/control-tower-api.js";
import { ApiClientError, getPrincipalId } from "../../api/client.js";
import { DEV_DEFAULT_PROJECT_ID } from "../../config.js";
import { ErrorPanel } from "../../components/ui.js";

export function ObjectiveSubmitPage() {
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);
  const [projectChoices, setProjectChoices] = useState<string[]>([
    DEV_DEFAULT_PROJECT_ID,
  ]);
  const [form, setForm] = useState({
    projectId: DEV_DEFAULT_PROJECT_ID,
    objectiveId: `obj_${crypto.randomUUID().slice(0, 8)}`,
    objectiveVersion: "1",
    requestedOutcome: "Admit a local patch-only objective",
    acceptanceCriteria: "Local patch artifact prepared\nTests executed",
    constraints: "No external side effects",
    nonGoals: "Execution\nLLM planning",
    priority: "HIGH",
    requestedEnvironment: "local",
    requesterId: getPrincipalId(),
  });

  useEffect(() => {
    let cancelled = false;
    void controlTowerApi
      .projects()
      .then((res) => {
        if (cancelled) return;
        if (res.projects.length > 0) {
          setProjectChoices(res.projects);
          setForm((prev) =>
            res.projects.includes(prev.projectId)
              ? prev
              : { ...prev, projectId: res.projects[0]! },
          );
        }
      })
      .catch(() => {
        /* keep development default */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const body = {
        projectId: form.projectId,
        objectiveId: form.objectiveId,
        objectiveVersion: Number(form.objectiveVersion),
        requestedOutcome: form.requestedOutcome,
        acceptanceCriteria: form.acceptanceCriteria
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
        constraints: form.constraints
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
        nonGoals: form.nonGoals
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
        priority: form.priority,
        requestedEnvironment: form.requestedEnvironment,
        requesterId: form.requesterId,
        submittedAt: new Date().toISOString(),
      };
      const result = await controlTowerApi.submitObjective(body);
      const runId = (result as { runId?: string }).runId;
      if (runId) {
        navigate(`/runs/${runId}`);
      } else {
        setError({
          code: (result as { reasonCode?: string }).reasonCode ?? "ADMISSION",
          message: JSON.stringify(result),
        });
      }
    } catch (err) {
      setError(err instanceof ApiClientError ? err : err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <h2>Submit Objective</h2>
      <p className="muted">
        Maps to canonical Phase 2 admission via POST /v1/runs. Server
        authorization remains authoritative.
      </p>
      <ErrorPanel error={error} />
      <form className="panel" onSubmit={onSubmit}>
        {(
          [
            ["projectId", "Project"],
            ["objectiveId", "Objective ID"],
            ["objectiveVersion", "Objective Version"],
            ["requestedOutcome", "Requested Outcome"],
            ["priority", "Priority"],
            ["requestedEnvironment", "Requested Environment"],
            ["requesterId", "Requester ID"],
          ] as const
        ).map(([key, label]) => (
          <div className="field" key={key}>
            <label htmlFor={key}>{label}</label>
            <input
              id={key}
              className="mono"
              list={key === "projectId" ? "authorized-projects" : undefined}
              value={form[key]}
              onChange={(e) => setForm({ ...form, [key]: e.target.value })}
              required
            />
            {key === "projectId" ? (
              <>
                <datalist id="authorized-projects">
                  {projectChoices.map((p) => (
                    <option key={p} value={p} />
                  ))}
                </datalist>
                <span className="muted">
                  Development default is isolated config; prefer authorized
                  projects from the server when bindings exist.
                </span>
              </>
            ) : null}
          </div>
        ))}
        <div className="field">
          <label htmlFor="acceptanceCriteria">Acceptance Criteria (one per line)</label>
          <textarea
            id="acceptanceCriteria"
            rows={3}
            value={form.acceptanceCriteria}
            onChange={(e) =>
              setForm({ ...form, acceptanceCriteria: e.target.value })
            }
            required
          />
        </div>
        <div className="field">
          <label htmlFor="constraints">Constraints (one per line)</label>
          <textarea
            id="constraints"
            rows={2}
            value={form.constraints}
            onChange={(e) => setForm({ ...form, constraints: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="nonGoals">Non-goals (one per line)</label>
          <textarea
            id="nonGoals"
            rows={2}
            value={form.nonGoals}
            onChange={(e) => setForm({ ...form, nonGoals: e.target.value })}
          />
        </div>
        <button type="submit" disabled={submitting}>
          {submitting ? "Submitting…" : "Admit Objective"}
        </button>
      </form>
    </div>
  );
}
