export interface ExecutionIdentityGenerator {
  nextExecutionAttemptId(): string;
  nextAuthoritySnapshotId(): string;
  nextArtifactId(): string;
  nextEventId(): string;
}

export class SequenceExecutionIdentityGenerator
  implements ExecutionIdentityGenerator
{
  private attempt = 0;
  private snapshot = 0;
  private artifact = 0;
  private event = 0;

  nextExecutionAttemptId(): string {
    this.attempt += 1;
    return `exec_attempt_${this.attempt}`;
  }

  nextAuthoritySnapshotId(): string {
    this.snapshot += 1;
    return `exec_auth_snap_${this.snapshot}`;
  }

  nextArtifactId(): string {
    this.artifact += 1;
    return `exec_artifact_${this.artifact}`;
  }

  nextEventId(): string {
    this.event += 1;
    return `exec_event_${this.event}`;
  }
}
