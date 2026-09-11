#!/usr/bin/env node
import { mintProductionReferenceRuntimeManifest } from "../src/qualification/index.ts";

const manifest = mintProductionReferenceRuntimeManifest("PRODUCTION");
console.log(JSON.stringify(manifest, null, 2));
