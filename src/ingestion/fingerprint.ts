import type {
  RepositoryFingerprintInput,
  RepositoryFingerprintService,
} from "./index-model.js";
import { hashCanonical } from "./hashing.js";

/**
 * Fingerprint includes:
 * - exact commit SHA
 * - lockfile path+content hashes
 * - relevant config path+content hashes (package.json, tsconfig, etc.)
 * - deterministic file-tree manifest hash
 *
 * Fingerprint excludes:
 * - branch name
 * - timestamps
 * - absolute machine paths
 * - mtime/atime/inode
 */
export class DeterministicRepositoryFingerprintService
  implements RepositoryFingerprintService
{
  fingerprint(input: RepositoryFingerprintInput): string {
    return hashCanonical({
      commitSha: input.commitSha.toLowerCase(),
      lockfileHashes: [...input.lockfileHashes].sort((a, b) =>
        a.path.localeCompare(b.path),
      ),
      configHashes: [...input.configHashes].sort((a, b) =>
        a.path.localeCompare(b.path),
      ),
      manifestHash: input.manifestHash,
    });
  }
}
