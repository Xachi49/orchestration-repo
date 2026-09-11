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
const migration = join(root, "migrations/019_phase24_production_synthesis.sql");
if (!existsSync(migration)) {
  fail("migration 019_phase24_production_synthesis.sql missing");
}

const lock = join(root, "package-lock.json");
if (!existsSync(lock)) {
  fail("package-lock.json missing");
}

const durability = readFileSync(
  join(root, "src/domain/durability/index.ts"),
  "utf8",
);
if (!durability.includes("019_phase24_production_synthesis")) {
  fail("SUPPORTED_SCHEMA_VERSION is not 019");
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
      supportedSchemaVersion: "019_phase24_production_synthesis",
      referenceRuntimeManifestHash: manifest.manifestHash,
      doctrineHash,
      message:
        "Static qualification preflight only. Full QUALIFIED_FOR_RELEASE requires postgres.phase24 acceptance with trusted evidence + Phase23 certificate.",
    },
    null,
    2,
  ),
);
