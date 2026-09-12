import { NavLink, Outlet } from "react-router-dom";
import { useEffect, useState } from "react";
import { controlTowerApi } from "../api/control-tower-api.js";
import { getPrincipalId, setPrincipalId } from "../api/client.js";

export function AppShell() {
  const [live, setLive] = useState<boolean | null>(null);
  const [ready, setReady] = useState<boolean | null>(null);
  const [principal, setPrincipal] = useState(getPrincipalId());
  const [devIdentityMode, setDevIdentityMode] = useState(false);
  const [devAllowAll, setDevAllowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const [l, r, identity] = await Promise.all([
          controlTowerApi.healthLive(),
          controlTowerApi.healthReady().catch(() => ({ ready: false })),
          controlTowerApi.identityMode().catch(() => null),
        ]);
        if (!cancelled) {
          setLive(Boolean(l.alive));
          setReady(Boolean(r.ready));
          setDevIdentityMode(Boolean(identity?.developmentIdentityAdapter));
          setDevAllowAll(Boolean(identity?.controlTowerDevAllowAll));
        }
      } catch {
        if (!cancelled) {
          setLive(false);
          setReady(false);
        }
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="layout">
      <nav className="nav">
        <h1>Control Tower</h1>
        <NavLink to="/" end>
          Dashboard
        </NavLink>
        <NavLink to="/objectives">Objectives</NavLink>
        <NavLink to="/runs">Runs</NavLink>
        <NavLink to="/approvals">Approval Inbox</NavLink>
        <NavLink to="/evidence">Evidence</NavLink>
        <NavLink to="/assurance">System Assurance</NavLink>
        <NavLink to="/qualification">Qualification</NavLink>
        <NavLink to="/governance">Governance</NavLink>
        <NavLink to="/federation">Federation</NavLink>
        <p className="doctrine" style={{ marginTop: "auto" }}>
          CONTROL TOWER ≠ AUTHORITY
        </p>
      </nav>
      <main className="main">
        {devAllowAll ? (
          <div
            className="dev-banner dev-banner-danger"
            role="status"
            data-testid="dev-allow-all-banner"
          >
            DEVELOPMENT UNRESTRICTED READ MODE — not production access control
          </div>
        ) : null}
        {devIdentityMode && !devAllowAll ? (
          <div className="dev-banner" role="status" data-testid="dev-identity-banner">
            DEVELOPMENT IDENTITY MODE — header principal is not production
            authentication
          </div>
        ) : null}
        <div className="header-bar">
          <div>
            <span className="badge">{live ? "LIVE" : "NOT LIVE"}</span>{" "}
            <span className="badge">{ready ? "READY" : "NOT READY"}</span>
            <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
              LIVE ≠ READY
            </div>
          </div>
          <label className="muted" style={{ display: "flex", gap: 8, alignItems: "center" }}>
            Acting as
            <input
              className="mono"
              value={principal}
              onChange={(e) => {
                setPrincipal(e.target.value);
                setPrincipalId(e.target.value);
              }}
              style={{ width: 160 }}
              title="Development principal selector only — not a credential"
            />
          </label>
        </div>
        <Outlet />
      </main>
    </div>
  );
}
