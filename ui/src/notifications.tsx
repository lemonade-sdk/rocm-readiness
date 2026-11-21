import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { z } from "zod";
import { readJson, resolveDatasetPath, type Fetcher, type Session } from "./data";
import { producedAt } from "./overview/formatDate";
import "./notifications.css";

const time = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const url = z.url({ protocol: /^https$/ });
const githubId = z.union([z.number().int().positive(), z.string().regex(/^[1-9]\d{0,19}$/)]);
const channel = z.object({
  status: z.enum(["pending", "sent", "failed", "disabled", "unavailable", "uncertain"]),
  url: url.optional(),
});
export const notificationsSchema = z.object({
  schema_version: z.literal(1),
  generated_at: time,
  dry_run: z.boolean().optional(),
  assessments: z.array(z.object({
    id: z.string(),
    rule_id: z.string(),
    rule_version: z.union([z.string(), z.number()]),
    evaluated_at: time,
    actionable: z.boolean(),
    applies_to: z.literal("missing_observation").optional(),
    classification: z.enum(["expected", "explained_abnormal", "unexplained"]),
    summary: z.string(),
    explanation: z.string(),
    escalation_required: z.boolean().optional(),
    diagnosis: z.object({
      method: z.enum(["model", "deterministic"]).optional(),
      certainty: z.enum(["likely", "verified", "unknown"]),
      cause: z.string().max(160).optional(),
      evidence_ids: z.array(z.string()).optional(),
    }).optional(),
    scope: z.object({
      repository: z.string().optional(), source_id: z.string().optional(),
      workflow: z.string().optional(), job: z.string().optional(),
      channel: z.string().optional(), platform: z.string().optional(),
      target: z.string().optional(), rocm_version: z.string().optional(), date: z.string().optional(),
    }),
    observed: z.record(z.string(), z.unknown()),
    expected: z.record(z.string(), z.unknown()),
    provenance: z.object({
      repository: z.string().optional(), run_id: githubId.optional(), job_id: githubId.optional(),
    }).optional(),
    evidence: z.array(z.object({ label: z.string(), url })),
    notification: z.object({
      github: channel, email: channel.optional(),
      status: z.enum(["pending", "sent", "failed"]),
    }).optional(),
  })),
});
export type Assessment = z.infer<typeof notificationsSchema>["assessments"][number];
export type AssessmentScope = Assessment["scope"];
type State = { assessments: Assessment[]; collectedAt?: string; message?: string; dryRun?: boolean };
const Notifications = createContext<State>({ assessments: [] });

export async function loadNotifications(session: Session, fetcher: Fetcher, signal?: AbortSignal): Promise<State> {
  const path = session.pointer.notifications_url ??
    (session.index.notifications ? resolveDatasetPath(session.indexUrl, session.index.notifications) : undefined);
  if (!path) return { assessments: [] };
  const data = await readJson(path, notificationsSchema, fetcher, signal);
  return { assessments: data.assessments, dryRun: data.dry_run };
}

export function NotificationsProvider({ session, fetcher, children }: {
  session: Session | null; fetcher: Fetcher; children: ReactNode;
}) {
  const [loaded, setLoaded] = useState<{ key: string; state: State }>();
  const key = session ? `${session.indexUrl}:${session.pointer.notifications_url ?? ""}:${session.index.notifications ?? ""}` : "";
  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    void loadNotifications(session, fetcher, controller.signal).then((state) => {
      if (!controller.signal.aborted) setLoaded({ key, state });
    }).catch(() => {
      if (!controller.signal.aborted) setLoaded({ key, state: {
        assessments: [], message: "Notification status unavailable.",
      } });
    });
    return () => controller.abort();
  }, [session, key, fetcher]);
  const state = loaded?.key === key ? loaded.state : { assessments: [] };
  return <Notifications value={{ ...state, collectedAt: session?.index.generated_at }}>{children}</Notifications>;
}

/** Match every persisted constraint; never borrow a nearby incident for a cell. */
export function matchesAssessment(assessment: Assessment, scope: AssessmentScope, missingObservation = false): boolean {
  const expected = assessment.scope;
  if (assessment.applies_to === "missing_observation") {
    if (!missingObservation || assessment.actionable || assessment.classification !== "expected" ||
        !expected.source_id || !expected.rocm_version || !expected.channel || !expected.platform) return false;
  } else if (!expected.date || expected.date !== scope.date) return false;
  if (!expected.source_id && !(expected.rocm_version && expected.channel) &&
      !(expected.repository && (expected.job || expected.workflow))) return false;
  return Object.entries(expected).every(([key, value]) => scope[key as keyof AssessmentScope] === value);
}

function assessmentPresentation(assessment: Assessment, dryRun?: boolean) {
  const dispatch = assessment.notification;
  const github = dispatch?.github.status;
  const cause = assessment.diagnosis?.certainty !== "unknown" ? assessment.diagnosis?.cause : undefined;
  const finding = cause ? cause
    : assessment.classification === "unexplained"
    ? assessment.summary : assessment.explanation;
  const githubText = dryRun ? "Preview only; no new notification sent."
    : github === "sent" ? assessment.escalation_required === true ? "Investigation pending." : "Team notified." : null;
  const needsInvestigation = (
    assessment.actionable || assessment.classification === "explained_abnormal"
  ) && assessment.escalation_required !== false && (githubText || dispatch?.github.url);
  const provenance = assessment.provenance;
  const ownJobUrl = provenance?.repository && provenance.repository === assessment.scope.repository &&
    provenance.run_id && provenance.job_id
    ? `https://github.com/${provenance.repository}/actions/runs/${provenance.run_id}/job/${provenance.job_id}`
    : undefined;
  return {
    finding,
    investigation: needsInvestigation ? { text: githubText, url: dispatch?.github.url, status: github } : null,
    evidence: assessment.evidence.map(item => ({
      ...item,
      jobs: item.label === "Job" && item.url === ownJobUrl && assessment.scope.job ? [assessment.scope.job] : [],
    })),
  };
}

type AssessmentPresentation = ReturnType<typeof assessmentPresentation>;

export function AssessmentDetails({ assessment }: { assessment: Assessment }) {
  const { dryRun } = useContext(Notifications);
  return <AssessmentExplanation presentation={assessmentPresentation(assessment, dryRun)} />;
}

function AssessmentExplanation({ presentation }: { presentation: AssessmentPresentation }) {
  const { finding, investigation, evidence } = presentation;
  return <div className="assessment-explanation">
    <dl>
      <dt>Finding</dt><dd>{finding}</dd>
      {investigation && <>
        <dt>Investigation</dt><dd className="assessment-investigation">
          {investigation.text && <span className="assessment-status">{investigation.text}</span>}
          {investigation.url && <> <a href={investigation.url} target="_blank" rel="noreferrer">View investigation</a></>}
        </dd>
      </>}
      {evidence.length > 0 && <>
        <dt>Evidence</dt><dd className="assessment-links">{evidence.map((item, index) =>
          <a key={`${item.url}:${index}`} href={item.url} target="_blank" rel="noreferrer">
            {item.label}{item.jobs.length > 0 ? ` · ${item.jobs.join(", ")}` : ""}
          </a>)}</dd>
      </>}
    </dl>
  </div>;
}

export function CellExplanation({ scope, observation, missingObservation = false }: {
  scope: AssessmentScope | AssessmentScope[]; observation?: string; missingObservation?: boolean;
}) {
  const state = useContext(Notifications);
  const scopes = Array.isArray(scope) ? scope : [scope];
  const matching = state.assessments.filter((assessment) =>
    scopes.some((item) => matchesAssessment(assessment, item, missingObservation)) &&
    (observation || assessment.actionable || assessment.classification === "explained_abnormal"),
  );
  const actionable = matching.filter((assessment) => assessment.actionable);
  // Aggregate cells can match separate incidents with the same displayed finding.
  // Group their presentation, preserving every distinct source link and investigation.
  const groups = new Map<string, {
    presentation: AssessmentPresentation;
    evidenceByKey: Map<string, AssessmentPresentation["evidence"][number]>;
  }>();
  for (const assessment of actionable.length ? actionable : matching) {
    const presentation = assessmentPresentation(assessment, state.dryRun);
    const key = JSON.stringify([presentation.finding, presentation.investigation]);
    let group = groups.get(key);
    if (!group) {
      group = { presentation: { ...presentation, evidence: [] }, evidenceByKey: new Map() };
      groups.set(key, group);
    }
    for (const item of presentation.evidence) {
      const evidenceKey = JSON.stringify([item.label, item.url]);
      const existing = group.evidenceByKey.get(evidenceKey);
      if (existing) {
        existing.jobs = [...new Set([...existing.jobs, ...item.jobs])];
      } else {
        group.evidenceByKey.set(evidenceKey, item);
        group.presentation.evidence.push(item);
      }
    }
  }
  const matches = [...groups];
  if (!observation && !matches.length && !state.message) return null;
  const collectedAt = observation && !matches.length ? state.collectedAt : undefined;
  return <div className="cell-explanation">
    {(!matches.length && observation || state.message || collectedAt) && <dl>
      {!matches.length && observation && <><dt>Observation</dt><dd>{observation}</dd></>}
      {state.message && <><dt>Investigation</dt><dd role="status">{state.message}</dd></>}
      {collectedAt && <><dt>Collected</dt><dd><time dateTime={collectedAt}>{producedAt(collectedAt)}</time></dd></>}
    </dl>}
    {!state.message && matches.map(([key, { presentation }]) => <AssessmentExplanation key={key} presentation={presentation} />)}
  </div>;
}
