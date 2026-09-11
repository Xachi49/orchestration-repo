import { createHash } from "node:crypto";
import { createReadStream, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { z } from "zod";
import { BUILD_MANIFEST_VERSION } from "./doctrine.js";
import { QualificationError } from "./errors.js";

export const DistFileEntrySchema = z
  .object({
    relativePath: z.string().min(1),
    contentHash: z.string().min(1),
  })
  .strict();

export type DistFileEntry = z.infer<typeof DistFileEntrySchema>;

export const BuildArtifactManifestSchema = z
  .object({
    buildManifestVersion: z.literal(BUILD_MANIFEST_VERSION),
    commitSha: z.string().min(1),
    packageLockHash: z.string().min(1),
    migrationSetFingerprint: z.string().min(1),
    supportedSchemaVersion: z.string().min(1),
    runtimeTarget: z.string().min(1),
    files: z.array(DistFileEntrySchema),
    buildArtifactFingerprint: z.string().min(1),
  })
  .strict();

export type BuildArtifactManifest = z.infer<typeof BuildArtifactManifestSchema>;

function normalizeRelativePath(path: string): string {
  return path.split(sep).join("/");
}

async function hashFileBytes(absolutePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(absolutePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return hash.digest("hex");
}

/** Enumerate regular files under root with relative normalized paths, sorted. */
export function listDistRelativePaths(distRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries.sort((a, b) => a.localeCompare(b))) {
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) {
        walk(abs);
      } else if (st.isFile()) {
        out.push(normalizeRelativePath(relative(distRoot, abs)));
      }
    }
  };
  walk(distRoot);
  return out.sort((a, b) => a.localeCompare(b));
}

export async function hashDistDirectory(
  distRoot: string,
): Promise<DistFileEntry[]> {
  const paths = listDistRelativePaths(distRoot);
  const files: DistFileEntry[] = [];
  for (const relativePath of paths) {
    const contentHash = await hashFileBytes(join(distRoot, relativePath));
    files.push({ relativePath, contentHash });
  }
  return files;
}

export function computeBuildArtifactFingerprint(input: {
  buildManifestVersion: string;
  commitSha: string;
  packageLockHash: string;
  migrationSetFingerprint: string;
  supportedSchemaVersion: string;
  runtimeTarget: string;
  files: readonly DistFileEntry[];
}): string {
  const files = [...input.files]
    .map((f) => ({
      relativePath: normalizeRelativePath(f.relativePath),
      contentHash: f.contentHash,
    }))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return createHash("sha256")
    .update(
      JSON.stringify({
        buildManifestVersion: input.buildManifestVersion,
        commitSha: input.commitSha,
        packageLockHash: input.packageLockHash,
        migrationSetFingerprint: input.migrationSetFingerprint,
        supportedSchemaVersion: input.supportedSchemaVersion,
        runtimeTarget: input.runtimeTarget,
        files,
      }),
      "utf8",
    )
    .digest("hex");
}

export function withBuildArtifactFingerprint(
  input: Omit<BuildArtifactManifest, "buildArtifactFingerprint">,
): BuildArtifactManifest {
  const fingerprint = computeBuildArtifactFingerprint(input);
  return BuildArtifactManifestSchema.parse({
    ...input,
    files: [...input.files].sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath),
    ),
    buildArtifactFingerprint: fingerprint,
  });
}

export function assertBuildArtifactIntegrity(
  manifest: BuildArtifactManifest,
): void {
  const recomputed = computeBuildArtifactFingerprint(manifest);
  if (recomputed !== manifest.buildArtifactFingerprint) {
    throw new QualificationError(
      "BUILD_ARTIFACT_INTEGRITY_FAILED",
      "Build artifact fingerprint mismatch",
      {
        expected: manifest.buildArtifactFingerprint,
        actual: recomputed,
      },
    );
  }
}
