#!/usr/bin/env node
/**
 * Phase24 static qualification PREFLIGHT only.
 * PRECHECK_PASS != QUALIFIED_FOR_RELEASE.
 * Does NOT create ReleaseQualificationRecord, deploy, push, or grant authority.
 */
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  FINAL_SYSTEM_DOCTRINE,
  QUALIFICATION_DOCTRINE,
  mintProductionReferenceRuntimeManifest,
  computeReferenceRuntimeManifestHash,
} from "../src/qualification/index.ts";

function fail(message) {
  console.error(`QUALIFY_FAIL: ${message}`);
  process.exit(1);
}

const root = process.cwd();
const migration019 = join(root, "migrations/019_phase24_production_synthesis.sql");
if (!existsSync(migration019)) {
  fail("migration 019_phase24_production_synthesis.sql missing");
}
const migration020 = join(root, "migrations/020_product_revenue_recovery.sql");
if (!existsSync(migration020)) {
  fail("migration 020_product_revenue_recovery.sql missing");
}
const migration021 = join(
  root,
  "migrations/021_product_revenue_recovery_integrity.sql",
);
if (!existsSync(migration021)) {
  fail("migration 021_product_revenue_recovery_integrity.sql missing");
}
const migration022 = join(
  root,
  "migrations/022_product_revenue_recovery_live_pilot.sql",
);
if (!existsSync(migration022)) {
  fail("migration 022_product_revenue_recovery_live_pilot.sql missing");
}

const lock = join(root, "package-lock.json");
if (!existsSync(lock)) {
  fail("package-lock.json missing");
}

const durability = readFileSync(
  join(root, "src/domain/durability/index.ts"),
  "utf8",
);
if (!durability.includes("022_product_revenue_recovery_live_pilot")) {
  fail("SUPPORTED_SCHEMA_VERSION is not 022_product_revenue_recovery_live_pilot");
}

const manifest = mintProductionReferenceRuntimeManifest("PRODUCTION");
const recomputed = computeReferenceRuntimeManifestHash(manifest);
if (recomputed !== manifest.manifestHash) {
  fail("reference runtime manifest hash mismatch");
}

if (manifest.faultInjectionAllowed) {
  fail("fault injection must be disabled");
}

const doctrineHash = createHash("sha256")
  .update(JSON.stringify({ QUALIFICATION_DOCTRINE, FINAL_SYSTEM_DOCTRINE }))
  .digest("hex");

console.log(
  JSON.stringify(
    {
      ok: true,
      precheckPass: true,
      qualifiedForRelease: false,
      deploymentAuthorized: false,
      note: "PRECHECK_PASS != QUALIFIED_FOR_RELEASE",
      supportedSchemaVersion: "022_product_revenue_recovery_live_pilot",
      referenceRuntimeManifestHash: manifest.manifestHash,
      doctrineHash,
      message:
        "Static qualification preflight only. Full QUALIFIED_FOR_RELEASE requires postgres.phase24 acceptance with trusted evidence + Phase23 certificate.",
    },
    null,
    2,
  ),
);
