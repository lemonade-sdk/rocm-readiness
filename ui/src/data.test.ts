import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadSession, loadVersion, resolveDatasetPath } from "./data";
import { fixtureFetch, index, indexUrl, overview, pointer } from "./fixtures";

describe("immutable dataset session", () => {
  it("treats an empty version parameter as default selection", async () => {
    const session = await loadSession("", fixtureFetch());
    expect(session.version).toBe("10.1");
    expect(session.overview?.rocm_version).toBe("10.1");
  });
  it("reads every version in the independently published repository snapshot", async () => {
    const fetcher = async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const path = url.pathname.split("/data/")[1];
      return new Response(await readFile(resolve("..", "data", path), "utf8"));
    };
    const session = await loadSession(undefined, fetcher);
    expect(session.index.versions.length).toBeGreaterThan(0);
    for (const row of session.index.versions) {
      const result = await loadVersion(session, row.rocm_version, fetcher);
      expect(result.overview?.rocm_version).toBe(row.rocm_version);
    }
  });
  it("accepts not_measured without inventing a measurement count", async () => {
    const data = { ...overview(), performance: { status: "not_measured" } };
    const session = await loadSession(
      undefined,
      fixtureFetch({
        [new URL("rocm/10.1/overview.json", indexUrl).href]: data,
      }),
    );
    expect(session.overview?.performance.status).toBe("not_measured");
    expect(session.overview?.performance.measurement_count).toBeUndefined();
  });
  it("loads the default through the pointer revision, not main", async () => {
    const fetcher = vi.fn(fixtureFetch());
    const result = await loadSession(undefined, fetcher);
    expect(result.version).toBe("10.1");
    expect(result.overview?.engines[0].build_count).toBe(26);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "https://raw.githubusercontent.com/lemonade-sdk/rocm-readiness/main/data/latest.json",
      indexUrl,
      new URL("rocm/10.1/overview.json", indexUrl).href,
    ]);
  });
  it("switches versions using the existing revision without rereading the pointer", async () => {
    const session = await loadSession(undefined, fixtureFetch());
    const fetcher = vi.fn(fixtureFetch());
    const result = await loadVersion(session, "10.0", fetcher);
    expect(result.version).toBe("10.0");
    expect(fetcher.mock.calls).toHaveLength(1);
    expect(String(fetcher.mock.calls[0][0])).toContain(
      `/${pointer.data_commit}/data/rocm/10.0/`,
    );
  });
  it("rejects unknown versions rather than silently showing another scope", async () => {
    await expect(loadSession("99", fixtureFetch())).rejects.toThrow(
      "ROCm 99 is not available",
    );
  });
  it("represents an empty dataset without selecting a nonexistent version", async () => {
    const session = await loadSession(
      undefined,
      fixtureFetch({
        [indexUrl]: { ...index, default_version: null, versions: [] },
      }),
    );
    expect(session.version).toBeNull();
    expect(session.overview).toBeNull();
  });
  it("rejects a default that is absent from a nonempty catalog", async () => {
    await expect(
      loadSession(
        undefined,
        fixtureFetch({ [indexUrl]: { ...index, default_version: "99" } }),
      ),
    ).rejects.toThrow("default_version");
  });
  it("rejects duplicate versions", async () => {
    await expect(
      loadSession(
        undefined,
        fixtureFetch({
          [indexUrl]: {
            ...index,
            versions: [index.versions[0], index.versions[0]],
          },
        }),
      ),
    ).rejects.toThrow("Duplicate ROCm");
  });
  it("keeps missing qualification evidence absent", async () => {
    const data = overview();
    const { qualified: _, ...build } = data.engines[0].latest_builds[0];
    const session = await loadSession(
      undefined,
      fixtureFetch({
        [new URL("rocm/10.1/overview.json", indexUrl).href]: {
          ...data,
          engines: [{ ...data.engines[0], latest_builds: [build] }],
        },
      }),
    );
    expect(
      session.overview?.engines[0].latest_builds[0].qualified,
    ).toBeUndefined();
  });
  it("rejects an overview for the wrong version", async () => {
    await expect(
      loadSession(
        undefined,
        fixtureFetch({
          [new URL("rocm/10.1/overview.json", indexUrl).href]: overview("10.0"),
        }),
      ),
    ).rejects.toThrow("does not match");
  });
  it("reports the failing file and field for malformed data", async () => {
    await expect(
      loadSession(
        undefined,
        fixtureFetch({ [indexUrl]: { ...index, versions: "bad" } }),
      ),
    ).rejects.toThrow(/index.json.*versions/);
  });
  it("rejects unsupported schema versions", async () => {
    await expect(
      loadSession(
        undefined,
        fixtureFetch({ [indexUrl]: { ...index, schema_version: 99 } }),
      ),
    ).rejects.toThrow("schema_version");
  });
  it("rejects a mutable index URL", async () => {
    const url =
      "https://raw.githubusercontent.com/lemonade-sdk/rocm-readiness/main/data/latest.json";
    await expect(
      loadSession(
        undefined,
        fixtureFetch({
          [url]: {
            ...pointer,
            index_url: indexUrl.replace(pointer.data_commit, "main"),
          },
        }),
      ),
    ).rejects.toThrow("immutable");
  });
  it("reports failed HTTP reads without inventing a dataset", async () => {
    await expect(
      loadSession(undefined, async () => new Response("", { status: 503 })),
    ).rejects.toThrow("HTTP 503");
  });
  it("reports invalid JSON with its source URL", async () => {
    await expect(
      loadSession(undefined, async () => new Response("not json")),
    ).rejects.toThrow(/latest.json.*JSON/);
  });
  it("retains failed ingestion status while opening the last good dataset", async () => {
    const url =
      "https://raw.githubusercontent.com/lemonade-sdk/rocm-readiness/main/data/latest.json";
    const session = await loadSession(
      undefined,
      fixtureFetch({
        [url]: {
          ...pointer,
          sync: {
            ...pointer.sync,
            status: "failed",
            errors: [
              {
                source_id: "stable",
                record: "",
                field: "",
                reason: "Feed unavailable",
              },
            ],
          },
        },
      }),
    );
    expect(session.pointer.sync.status).toBe("failed");
    expect(session.overview?.rocm_version).toBe("10.1");
  });
  it.each([
    "../sync.json",
    "/data/index.json",
    "//example.com/a",
    "https://example.com/a",
    "%2e%2e/a",
    "rocm/a?x=1",
    "rocm/../a",
    "rocm\\a",
  ])("rejects paths escaping the session: %s", (path) => {
    expect(() => resolveDatasetPath(indexUrl, path)).toThrow("dataset path");
  });
});
