import { NavLink, Route, Routes } from "react-router-dom";
import { AppShell } from "./AppShell.js";
import { DashboardPage } from "../features/dashboard/DashboardPage.js";
import { ObjectiveSubmitPage } from "../features/objectives/ObjectiveSubmitPage.js";
import { RunDetailPage, RunsListPage } from "../features/runs/RunPages.js";
import {
  ApprovalDecisionPage,
  ApprovalInboxPage,
} from "../features/approvals/ApprovalPages.js";
import {
  AssurancePage,
  EvidencePage,
  FederationPage,
  GovernancePage,
  QualificationPage,
} from "../features/system/SystemPages.js";

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<DashboardPage />} />
        <Route path="objectives" element={<ObjectiveSubmitPage />} />
        <Route path="runs" element={<RunsListPage />} />
        <Route path="runs/:runId" element={<RunDetailPage />} />
        <Route path="approvals" element={<ApprovalInboxPage />} />
        <Route
          path="approvals/:approvalRequestId"
          element={<ApprovalDecisionPage />}
        />
        <Route path="evidence" element={<EvidencePage />} />
        <Route path="assurance" element={<AssurancePage />} />
        <Route path="qualification" element={<QualificationPage />} />
        <Route path="governance" element={<GovernancePage />} />
        <Route path="federation" element={<FederationPage />} />
        <Route
          path="*"
          element={
            <p>
              Not found. <NavLink to="/">Dashboard</NavLink>
            </p>
          }
        />
      </Route>
    </Routes>
  );
}
