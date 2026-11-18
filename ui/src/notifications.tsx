import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { z } from "zod";
import { readJson, resolveDatasetPath, type Fetcher, type Session } from "./data";
import { producedAt } from "./overview/formatDate";
import "./notifications.css";

const time = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const url = z.url({ protocol: /^https$/ });
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

export function AssessmentDetails({ assessment }: { assessment: Assessment }) {
  const { dryRun } = useContext(Notifications);
  const dispatch = assessment.notification;
  const github = dispatch?.github.status;
  const cause = assessment.diagnosis?.certainty !== "unknown" ? assessment.diagnosis?.cause : undefined;
  const finding = cause ? `${assessment.diagnosis?.method === "model" ? "Likely: " : ""}${cause}`
    : assessment.classification === "unexplained"
    ? assessment.summary : assessment.explanation;
  const githubText = dryRun ? "Preview only; no new notification sent."
    : github === "sent" ? assessment.escalation_required === true ? "Investigation pending." : "Team notified." : null;
  const needsInvestigation = (
    assessment.actionable || assessment.classification === "explained_abnormal"
  ) && assessment.escalation_required !== false && (githubText || dispatch?.github.url);
  return <div className="assessment-explanation">
    <dl>
      <dt>Finding</dt><dd>{finding}</dd>
      {needsInvestigation && <>
        <dt>Investigation</dt><dd className="assessment-investigation">
          {githubText && <span className="assessment-status">{githubText}</span>}
          {dispatch?.github.url && <> <a href={dispatch.github.url} target="_blank" rel="noreferrer">View investigation</a></>}
        </dd>
      </>}
      {assessment.evidence.length > 0 && <>
        <dt>Evidence</dt><dd className="assessment-links">{assessment.evidence.map((item, index) =>
          <a key={`${item.url}:${index}`} href={item.url} target="_blank" rel="noreferrer">{item.label}</a>)}</dd>
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
  const normalExplanations = new Set<string>();
  const matches = (actionable.length ? actionable : matching).filter((assessment) => {
    if (assessment.classification !== "expected") return true;
    const key = JSON.stringify([assessment.scope, assessment.explanation, assessment.notification]);
    if (normalExplanations.has(key)) return false;
    normalExplanations.add(key);
    return true;
  });
  if (!observation && !matches.length && !state.message) return null;
  const collectedAt = observation && !matches.length ? state.collectedAt : undefined;
  return <div className="cell-explanation">
    {(!matches.length && observation || state.message || collectedAt) && <dl>
      {!matches.length && observation && <><dt>Observation</dt><dd>{observation}</dd></>}
      {state.message && <><dt>Investigation</dt><dd role="status">{state.message}</dd></>}
      {collectedAt && <><dt>Collected</dt><dd><time dateTime={collectedAt}>{producedAt(collectedAt)}</time></dd></>}
    </dl>}
    {!state.message && matches.map((assessment) => <AssessmentDetails key={assessment.id} assessment={assessment} />)}
  </div>;
}
