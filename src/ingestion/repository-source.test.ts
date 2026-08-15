import { describe, expect, it } from "vitest";
import { parseGitHubRemoteUrl } from "./repository-source.js";

describe("parseGitHubRemoteUrl", () => {
  it("parses HTTPS URLs", () => {
    expect(
      parseGitHubRemoteUrl("https://github.com/example/discord-scale-architect"),
    ).toEqual({ owner: "example", repository: "discord-scale-architect" });
  });

  it("parses SSH URLs and strips .git", () => {
    expect(
      parseGitHubRemoteUrl("git@github.com:acme/widgets.git"),
    ).toEqual({ owner: "acme", repository: "widgets" });
  });

  it("rejects non-GitHub URLs", () => {
    expect(parseGitHubRemoteUrl("https://gitlab.com/acme/widgets")).toBeNull();
  });
});
