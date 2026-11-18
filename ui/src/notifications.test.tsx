import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { loadSession, type Session } from "./data";
import { fixtureFetch, index, indexUrl, pointer } from "./fixtures";
import {
  AssessmentDetails, CellExplanation, loadNotifications, matchesAssessment,
  NotificationsProvider, type Assessment,
} from "./notifications";
import { Tooltip } from "./overview/Tooltip";

const live = "https://raw.githubusercontent.com/lemonade-sdk/rocm-readiness/main/data/notifications.json";
const assessment: Assessment = {
  id: "exact-incident", rule_id: "missing", rule_version: 1,
  evaluated_at: "2026-11-17T13:00:00Z", actionable: true, classification: "unexplained",
  summary: "No run observed", explanation: "The operating policy's observation age was exceeded.",
  scope: { repository: "owner/repo", workflow: "ci.yml", job: "linux", date: "2026-11-17" },
  observed: {}, expected: {}, evidence: [],
};
const document = { schema_version: 1, generated_at: assessment.evaluated_at, assessments: [assessment] };

it("shows a supported short diagnosis in the existing Finding without escalation", () => {
  render(<AssessmentDetails assessment={{ ...assessment,
    escalation_required: false,
    diagnosis: { method: "model", certainty: "likely", cause: "The linker could not find libamdhip64.", evidence_ids: ["E1"] },
    notification: { github: { status: "sent", url: "https://github.com/owner/repo/issues/123" }, status: "sent" },
  }} />);
  expect(screen.getByText("The linker could not find libamdhip64.")).toBeVisible();
  expect(screen.getAllByRole("term").map(term => term.textContent)).toEqual(["Finding"]);
  expect(screen.queryByRole("link", { name: "View investigation" })).not.toBeInTheDocument();
});

it("shows investigation pending only for persisted accepted escalation", () => {
  render(<AssessmentDetails assessment={{ ...assessment, escalation_required: true,
    diagnosis: { method: "model", certainty: "unknown" },
    notification: { github: { status: "sent", url: "https://github.com/owner/repo/issues/123" }, status: "sent" },
  }} />);
  expect(screen.getByText("Investigation pending.")).toBeVisible();
  expect(screen.getByRole("link", { name: "View investigation" })).toHaveAttribute("href", "https://github.com/owner/repo/issues/123");
  expect(screen.queryByText("Team notified.")).not.toBeInTheDocument();
});

describe("optional persisted notification data", () => {
  it("keeps older datasets readable without fetching a notification document", async () => {
    const fetcher = vi.fn(fixtureFetch());
    const session = await loadSession(undefined, fetcher);
    fetcher.mockClear();
    expect(await loadNotifications(session, fetcher)).toEqual({ assessments: [] });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("prefers validated live state to the pinned preview", async () => {
    const fetcher = vi.fn(fixtureFetch({
      [live]: document,
      [indexUrl]: { ...index, notifications: "notifications.json" },
      "https://raw.githubusercontent.com/lemonade-sdk/rocm-readiness/main/data/latest.json": {
        ...pointer, notifications_url: live,
      },
    }));
    const session = await loadSession(undefined, fetcher);
    expect((await loadNotifications(session, fetcher)).assessments[0].id).toBe(assessment.id);
    expect(fetcher).toHaveBeenLastCalledWith(live, expect.objectContaining({ cache: "no-store", redirect: "error" }));
    expect(fetcher.mock.calls.some(([input]) => String(input) === new URL("notifications.json", indexUrl).href)).toBe(false);
  });

  it("rejects a live URL from another repository or with query parameters", async () => {
    for (const bad of [live.replace("/rocm-readiness/", "/other/"), `${live}?token=value`]) {
      await expect(loadSession(undefined, fixtureFetch({
        "https://raw.githubusercontent.com/lemonade-sdk/rocm-readiness/main/data/latest.json": {
          ...pointer, notifications_url: bad,
        },
      }))).rejects.toThrow(/notifications_url/);
    }
  });

  it("loads pinned previews and reports live failure without claiming stale preview delivery", async () => {
    const session = await loadSession(undefined, fixtureFetch({ [indexUrl]: { ...index, notifications: "notifications.json" } }));
    expect((await loadNotifications(session, fixtureFetch({
      [new URL("notifications.json", indexUrl).href]: document,
    }))).assessments).toHaveLength(1);
    const liveSession: Session = { ...session, pointer: { ...session.pointer, notifications_url: live } };
    render(<NotificationsProvider session={liveSession} fetcher={fixtureFetch()}>
      <CellExplanation scope={assessment.scope} observation="No collected observation." />
    </NotificationsProvider>);
    expect(await screen.findByRole("status")).toHaveTextContent("Notification status unavailable.");
    expect(screen.queryByText(/Team notified/)).not.toBeInTheDocument();
  });
});

it("binds incidents to all exact scope constraints, never just a matching date or project", () => {
  const exact = { ...assessment.scope, platform: "linux" };
  expect(matchesAssessment(assessment, exact)).toBe(true);
  for (const change of [{ job: "windows" }, { workflow: "other.yml" }, { date: "2026-11-16" }, { repository: "other/repo" }]) {
    expect(matchesAssessment(assessment, { ...exact, ...change })).toBe(false);
  }
  expect(matchesAssessment({ ...assessment, scope: { source_id: "collector" } }, exact)).toBe(false);
  expect(matchesAssessment({ ...assessment, scope: { date: exact.date } }, exact)).toBe(false);
  expect(matchesAssessment({ ...assessment, scope: { ...assessment.scope, target: "gfx1151" } }, exact)).toBe(false);
});

it("uses configured retained-track wording only for empty cells in that exact track and platform", async () => {
  const policy: Assessment = {
    ...assessment, applies_to: "missing_observation", actionable: false, classification: "expected",
    summary: "Monitoring paused",
    explanation: "Nightly monitoring has moved from ROCm 10.2.0 to ROCm 10.3.0.",
    scope: { repository: "lemonade-sdk/llamacpp-rocm", source_id: "llamacpp-nightly-qualification",
      channel: "nightly", platform: "windows", rocm_version: "10.2.0" },
  };
  const scope = { ...policy.scope, date: "2026-11-07" };
  expect(matchesAssessment(policy, scope)).toBe(false);
  expect(matchesAssessment(policy, scope, true)).toBe(true);
  expect(matchesAssessment(policy, { ...scope, date: "2026-11-18" }, true)).toBe(true);
  for (const change of [{ rocm_version: "10.3.0" }, { platform: "linux" }, { source_id: "other" }]) {
    expect(matchesAssessment(policy, { ...scope, ...change }, true)).toBe(false);
  }
  expect(matchesAssessment({ ...policy, actionable: true }, scope, true)).toBe(false);
  const session = await loadSession(undefined, fixtureFetch({ [indexUrl]: { ...index, notifications: "notifications.json" } }));
  render(<NotificationsProvider session={session} fetcher={fixtureFetch({
    [new URL("notifications.json", indexUrl).href]: { ...document, assessments: [policy] },
  })}>
    <CellExplanation scope={scope} observation="No qualification result collected for this date." missingObservation />
  </NotificationsProvider>);
  expect(await screen.findByText(policy.explanation)).toBeVisible();
  expect(screen.queryByText("No qualification result collected for this date.")).not.toBeInTheDocument();
  expect(screen.queryByText(/dispatch|notified|Investigation/)).not.toBeInTheDocument();
});

it("shows the unexplained finding without transient issue-creation messages", () => {
  render(<AssessmentDetails assessment={{
    ...assessment, summary: "Skipped result", explanation: "The reason is not established.",
    notification: {
      github: { status: "pending" }, email: { status: "disabled" }, status: "pending",
    },
  }} />);
  expect(screen.getAllByRole("term").map(term => term.textContent)).toEqual(["Finding"]);
  expect(screen.getByText("Skipped result")).toBeVisible();
  expect(screen.queryByText(/pending|notified|could not be created/)).not.toBeInTheDocument();
  expect(screen.queryByText(/reason is not established|Unexplained|Email|Assessed/)).not.toBeInTheDocument();
});

it("uses one concise finding sentence rather than separate Finding and Details rows", () => {
  render(<AssessmentDetails assessment={{
    ...assessment, classification: "explained_abnormal",
    summary: "Producer failure", explanation: "Some tests in the job have failed.",
    notification: { github: { status: "sent", url: "https://github.com/owner/repo/issues/123" }, status: "sent" },
  }} />);
  expect(screen.getAllByRole("term").map(term => term.textContent)).toEqual(["Finding", "Investigation"]);
  expect(screen.getByText("Some tests in the job have failed.")).toBeVisible();
  expect(screen.queryByText("Producer failure")).not.toBeInTheDocument();
});

it("retains an existing investigation link without displaying transient notification failure text", () => {
  render(<AssessmentDetails assessment={{
    ...assessment, notification: {
      github: { status: "failed", url: "https://github.com/owner/repo/issues/123" }, status: "failed",
    },
  }} />);
  expect(screen.queryByText(/notification failed|contact the development team|Team notified/i)).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "View investigation" })).toHaveAttribute("href", "https://github.com/owner/repo/issues/123");
  expect(screen.queryByText(/create an issue manually/)).not.toBeInTheDocument();
});

it("uses the existing evidence-table structure for a missing observation without inventing dispatch", () => {
  render(<CellExplanation scope={assessment.scope} observation="No result collected." />);
  expect(screen.getAllByRole("term").map(term => term.textContent)).toEqual(["Observation"]);
  expect(screen.getByRole("definition")).toHaveTextContent("No result collected.");
  expect(screen.queryByText(/reason is not established|notification|Issue dispatch/)).not.toBeInTheDocument();
});

it.each(["pending", "sent", "failed", "disabled", "unavailable", "uncertain"] as const)(
  "describes GitHub %s and preserves the exact incident link", (status) => {
    render(<AssessmentDetails assessment={{ ...assessment, notification: {
      github: { status, url: "https://github.com/owner/repo/issues/123" },
      email: { status: "disabled" }, status: status === "sent" ? "sent" : "pending",
    } }} />);
    expect(screen.queryByText("Email", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View investigation" })).toHaveAttribute("href", "https://github.com/owner/repo/issues/123");
    if (status === "sent") expect(screen.getByText("Team notified.")).toBeVisible();
    else expect(screen.queryByText(/Team notified|pending|failed|disabled|unavailable|uncertain/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Email accepted/)).not.toBeInTheDocument();
  },
);

it.each(["pending", "failed", "disabled", "unavailable", "uncertain"] as const)(
  "keeps %s in CI data without a notification row or false success claim", (status) => {
    render(<AssessmentDetails assessment={{ ...assessment, notification: {
      github: { status }, status: "pending",
    } }} />);
    expect(screen.getAllByRole("term").map(term => term.textContent)).toEqual(["Finding"]);
    expect(screen.queryByText(/Team notified|pending|failed|disabled|unavailable|uncertain|could not be created/i)).not.toBeInTheDocument();
  },
);

it.each(["pending", "sent", "failed"] as const)(
  "does not show notification %s or investigation-pending wording on a healthy recovery", (status) => {
    render(<AssessmentDetails assessment={{
      ...assessment, actionable: false, classification: "expected",
      summary: "Failure not present", explanation: "Latest complete result passed.",
      observed: { status: "pass", complete: true },
      notification: {
        github: { status, url: "https://github.com/owner/repo/issues/123" },
        email: { status: "disabled" }, status: status === "sent" ? "sent" : "pending",
      },
    }} />);
    expect(screen.getByText("Latest complete result passed.")).toBeVisible();
    expect(screen.queryByText(/GitHub issue creation|Notification could not|Team notified|Email|investigation pending/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "View investigation" })).not.toBeInTheDocument();
  },
);

it("retains the parent investigation status for an explained abnormal dependency skip", () => {
  render(<AssessmentDetails assessment={{
    ...assessment, actionable: false, classification: "explained_abnormal",
    summary: "Dependency skip", explanation: "The required job failed.",
    notification: {
      github: { status: "sent", url: "https://github.com/owner/repo/issues/123" },
      email: { status: "disabled" }, status: "sent",
    },
  }} />);
  expect(screen.getByText("Team notified.")).toBeVisible();
  expect(screen.getByRole("link", { name: "View investigation" })).toHaveAttribute("href", "https://github.com/owner/repo/issues/123");
});

it("displays exact assessments without unrelated incidents or recovery rows", async () => {
  const sent = { ...assessment, notification: { github: { status: "failed" as const }, status: "failed" as const } };
  const session = await loadSession(undefined, fixtureFetch({ [indexUrl]: { ...index, notifications: "notifications.json" } }));
  const fetcher = fixtureFetch({ [new URL("notifications.json", indexUrl).href]: { ...document, assessments: [
    { ...assessment, id: "recovery", actionable: false, classification: "expected", summary: "Other anomaly recovered" },
    sent, { ...assessment, id: "other", scope: { ...assessment.scope, job: "other" }, summary: "Unrelated incident" },
  ] } });
  render(<NotificationsProvider session={session} fetcher={fetcher}>
    <CellExplanation scope={assessment.scope} observation="No collected observation." />
  </NotificationsProvider>);
  expect(await screen.findByText(sent.summary)).toBeVisible();
  expect(screen.queryByText(/could not be created|creation pending|Team notified/)).not.toBeInTheDocument();
  expect(screen.queryByText("Unrelated incident")).not.toBeInTheDocument();
  expect(screen.queryByText("Other anomaly recovered")).not.toBeInTheDocument();
  expect(screen.queryByText("Expected / normal")).not.toBeInTheDocument();
});

it("shows notification status only inside the hovered status tooltip", async () => {
  const session = await loadSession(undefined, fixtureFetch({ [indexUrl]: { ...index, notifications: "notifications.json" } }));
  render(<NotificationsProvider session={session} fetcher={fixtureFetch({
    [new URL("notifications.json", indexUrl).href]: { ...document, assessments: [{
      ...assessment, notification: {
        github: { status: "sent", url: "https://github.com/owner/repo/issues/123" },
        email: { status: "disabled" }, status: "sent",
      },
    }] },
  })}>
    <Tooltip label="Failed upstream job" interactive content={
      <CellExplanation scope={assessment.scope} observation="Producer failed." />
    }>×</Tooltip>
  </NotificationsProvider>);
  expect(screen.queryByText(/Team notified/)).not.toBeInTheDocument();
  expect(screen.queryByText(/actionable assessment/)).not.toBeInTheDocument();
  fireEvent.mouseEnter(screen.getByRole("button", { name: "Failed upstream job" }));
  expect(await screen.findByText("Team notified.")).toBeVisible();
  expect(screen.getByRole("dialog")).toContainElement(screen.getByRole("link", { name: "View investigation" }));
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByText(/Team notified/)).not.toBeInTheDocument());
});

it("labels dry-run delivery values as preview rather than notification success", async () => {
  const session = await loadSession(undefined, fixtureFetch({ [indexUrl]: { ...index, notifications: "notifications.json" } }));
  render(<NotificationsProvider session={session} fetcher={fixtureFetch({
    [new URL("notifications.json", indexUrl).href]: { ...document, dry_run: true, assessments: [{
      ...assessment, notification: { github: { status: "sent" }, status: "sent" },
    }] },
  })}><CellExplanation scope={assessment.scope} observation="No collected observation." /></NotificationsProvider>);
  expect(await screen.findByText("Preview only; no new notification sent.")).toBeVisible();
  expect(screen.queryByText(/Team notified|Accepted by provider/)).not.toBeInTheDocument();
});

it("shows a verified-normal explanation once when several anomaly recovery rows share it", async () => {
  const session = await loadSession(undefined, fixtureFetch({ [indexUrl]: { ...index, notifications: "notifications.json" } }));
  render(<NotificationsProvider session={session} fetcher={fixtureFetch({
    [new URL("notifications.json", indexUrl).href]: { ...document, assessments: [
      { ...assessment, id: "failure-normal", actionable: false, classification: "expected", summary: "Failure recovered", explanation: "Source result is acceptable." },
      { ...assessment, id: "warning-normal", actionable: false, classification: "expected", summary: "Warning recovered", explanation: "Source result is acceptable." },
    ] },
  })}><CellExplanation scope={assessment.scope} observation="Source completed." /></NotificationsProvider>);
  expect(await screen.findAllByText("Source result is acceptable.")).toHaveLength(1);
  expect(screen.queryByText("Warning recovered")).not.toBeInTheDocument();
  expect(screen.queryByText(/GitHub issue creation|Notification could not|Team notified/)).not.toBeInTheDocument();
});

it("adds nothing to existing observed-result tooltips when there is no abnormal assessment", async () => {
  const session = await loadSession(undefined, fixtureFetch({ [indexUrl]: { ...index, notifications: "notifications.json" } }));
  const fetcher = vi.fn(fixtureFetch({
    [new URL("notifications.json", indexUrl).href]: { ...document, assessments: [{
      ...assessment, actionable: false, classification: "expected",
      summary: "Failure not present", explanation: "The result passed.",
      notification: { github: { status: "pending" }, email: { status: "disabled" }, status: "pending" },
    }] },
  }));
  const { container } = render(<NotificationsProvider session={session} fetcher={fetcher}>
    <CellExplanation scope={assessment.scope} />
  </NotificationsProvider>);
  await waitFor(() => expect(fetcher).toHaveBeenCalled());
  await act(async () => { await fetcher.mock.results[0].value; });
  expect(container.querySelector(".cell-explanation")).toBeNull();
  expect(screen.queryByText(/Failure not present|reason is not established|notification|Snapshot collected/)).not.toBeInTheDocument();
});
