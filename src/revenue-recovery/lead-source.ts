/**
 * Lead source adapter kinds for Continuum Revenue Recovery.
 * MVP + live pilot: MANUAL | WEBHOOK | FAKE_TEST_SOURCE | WEB_FORM
 * Future adapters (not implemented): Wix (may translate into WEB_FORM),
 * GoHighLevel, HubSpot, Jobber, Housecall Pro, ServiceTitan,
 * Facebook Lead Ads, Google Local Services.
 */
export { LEAD_SOURCES, type LeadSource } from "./lead.js";

export type LeadSourceAdapterKind =
  | "MANUAL"
  | "WEBHOOK"
  | "FAKE_TEST_SOURCE"
  | "WEB_FORM";

export function isMvpLeadSource(source: string): source is LeadSourceAdapterKind {
  return (
    source === "MANUAL" ||
    source === "WEBHOOK" ||
    source === "FAKE_TEST_SOURCE" ||
    source === "WEB_FORM"
  );
}
