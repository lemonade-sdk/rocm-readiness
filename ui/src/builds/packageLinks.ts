import type { Build } from "../data";

export function buildRepository(build: Build) {
  return build.source_url?.match(/^https:\/\/raw\.githubusercontent\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/[a-f0-9]{40}\/qualification\/index\.json$/)?.[1];
}

export function archiveHref(build: Build): string | undefined {
  const repository = buildRepository(build);
  if (build.published !== true || !repository || !build.tag || !build.artifact ||
      !/^[^/\\]+\.(?:zip|tar\.gz|tgz|gz)$/i.test(build.artifact)) return undefined;
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(build.tag)}/${encodeURIComponent(build.artifact)}`;
}
