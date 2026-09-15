/**
 * Lead source adapter kinds for Continuum Revenue Recovery.
 * MVP: MANUAL | WEBHOOK | FAKE_TEST_SOURCE
 * Future adapters (not implemented): GoHighLevel, HubSpot, Jobber,
 * Housecall Pro, ServiceTitan, Facebook Lead Ads, Google Local Services.
 */
export { LEAD_SOURCES, type LeadSource } from "./lead.js";

export type LeadSourceAdapterKind =
  | "MANUAL"
  | "WEBHOOK"
  | "FAKE_TEST_SOURCE";

export function isMvpLeadSource(source: string): source is LeadSourceAdapterKind {
  return (
    source === "MANUAL" ||
    source === "WEBHOOK" ||
    source === "FAKE_TEST_SOURCE"
  );
}
