import type { Evidence, MetricRule } from "@ossilic/spec";
import type { Comparison, Effect, Verdict } from "./compare.ts";

const pct = (x: number) => `${(x * 100).toFixed(1).replace(/\.0$/, "")}%`;
const pts = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1).replace(/\.0$/, "")}`;
const val = (r: MetricRule, x: number) => (r.metric === "success" ? `${pts(x)} pts` : `${x >= 0 ? "+" : ""}${+x.toFixed(3)}`);
const range = (e: Effect) => (Number.isFinite(e.lo) ? `${val(e.rule, e.lo)} to ${val(e.rule, e.hi)}` : "—");
const margin = (r: MetricRule) => (r.metric === "success" ? `±${(r.margin * 100).toFixed(1).replace(/\.0$/, "")} pts` : `±${r.margin}`);
const seeds = (xs: number[]) => (xs.length ? xs.slice(0, 12).join(", ") + (xs.length > 12 ? ` and ${xs.length - 12} more` : "") : "none");
const rate = (s: Evidence["summary"]) => `${s.successes}/${s.n} (${pct(s.successRate)}, ${pct(s.ci95[0])}–${pct(s.ci95[1])})`;

export const VERDICT_WORDS: Record<Verdict, string> = {
  meaningfully_improved: "Meaningfully improved", meaningfully_regressed: "Meaningfully regressed", no_meaningful_change: "No meaningful change",
  inconclusive: "Inconclusive", not_comparable: "Not comparable", invalid_evaluation: "Invalid evaluation",
  exact_reproduction: "Exact reproduction", equivalent_reproduction: "Equivalent reproduction", did_not_reproduce: "Did not reproduce",
};

/** The facts behind a result, each stated on its own: nothing is folded into one badge. */
export function trustFacts(e: Evidence): string[] {
  const a = e.accounting, invalid = a.byStatus.infra_error + a.byStatus.invalid;
  return [
    e.executedBy.mode === "ci" ? `run in CI: ${e.executedBy.ci!.repository} @ ${e.executedBy.ci!.commit.slice(0, 7)}` : "run locally, self-reported",
    `${a.planned - invalid}/${a.planned} worlds valid${invalid ? ` (${a.byStatus.infra_error} infrastructure errors, ${a.byStatus.invalid} invalid worlds)` : ""}`,
    e.driver === "ros2" ? "hardware, as attested by the author" : `simulation (${e.environment.kernel})`,
    `cases: ${e.cases.kind}, ${e.cases.generator}`,
  ];
}

const shown = (v: unknown) => (v === undefined ? "default" : JSON.stringify(v));

function changesSection(c: Comparison): string[] {
  if (!c.changes.length) return ["Nothing in the brain or body changed."];
  return c.changes.slice(0, 15).map((x) =>
    x.kind === "param" ? `- \`${x.path}\`: ${shown(x.from)} → ${shown(x.to)}`
      : x.kind === "file" ? `- file \`${x.path}\` changed (${x.from} → ${x.to}); its contents are compared by hash only`
      : x.kind === "node" ? `- node \`${x.path}\`: ${x.from ?? "absent"} → ${x.to ?? "removed"}`
      : x.kind === "edge" ? `- wire \`${x.path}\`: ${x.to}`
      : `- ${x.kind} \`${x.path}\`: ${shown(x.from)} → ${shown(x.to)}`).concat(c.changes.length > 15 ? [`- and ${c.changes.length - 15} more`] : []);
}

/** A pull-request comment and a terminal report: the decision first, then everything behind it (I1-SPEC §9). */
export function markdownReport(c: Comparison, base: Evidence, cand: Evidence, reproduce?: string): string {
  const level = `${+((1 - c.alpha) * 100).toFixed(1)}%`;
  const L: string[] = [];
  const gate = c.verdict.endsWith("reproduction") ? "" : c.gate.pass ? "✅ Not meaningfully worse: safe to ship" : "⛔ Blocked";
  L.push(`### Ossilic Release Check · ${cand.machine.name} · ${cand.suite.name} — ${gate || VERDICT_WORDS[c.verdict]}`, "");
  if (gate) L.push(`**Verdict: ${VERDICT_WORDS[c.verdict]}.** ${c.reason}`); else L.push(c.reason);
  if (!c.gate.pass && c.gate.reasons.length) L.push("", ...c.gate.reasons.map((x) => `- ${x}`));

  if (c.primary) {
    L.push("", `| ${level} intervals, positive is better | Change | Interval | Margin | Verdict |`, "|---|---|---|---|---|");
    const row = (e: Effect, label: string) => `| ${label} ${e.rule.metric} | ${val(e.rule, e.estimate)} | ${range(e)} | ${margin(e.rule)} | ${e.note ?? (label === "Guardrail" ? (e.nonInferior ? "not worse" : "may be worse") : VERDICT_WORDS[e.verdict])} |`;
    L.push(row(c.primary, "Primary"), ...c.guardrails.map((g) => row(g, "Guardrail")));
    if (c.exploratory.length) L.push(...c.exploratory.map((e) => `| Exploratory ${e.rule.metric} (raw change) | ${val(e.rule, e.estimate)} | ${range(e)} | — | not used to decide |`));
  }

  L.push("", "**Trust**", ...trustFacts(cand).map((x) => `- ${x}`));
  if (c.primary) L.push("", "**What changed**", ...changesSection(c));
  L.push("", "**Which worlds changed**",
    `- Success: ${rate(base.summary)} → ${rate(cand.summary)}`,
    `- Newly failing: ${seeds(c.newlyFailing)}`,
    `- Newly passing: ${seeds(c.newlyPassing)}`);
  L.push("", "**Accounting**", `- ${c.paired} paired worlds analysed${c.dropped.length ? `; ${c.dropped.length} left out (${c.dropped.slice(0, 5).map((d) => `${d.seed}: ${d.reason}`).join(", ")}${c.dropped.length > 5 ? ", …" : ""})` : "; none left out"}`);
  if (c.power) L.push(`- Power: this comparison can resolve about ${c.power.metric === "success" ? `${(c.power.resolvable * 100).toFixed(1)} points` : c.power.resolvable.toFixed(3)}; resolving the margin of ${c.power.metric === "success" ? `${(c.power.margin * 100).toFixed(0)} points` : c.power.margin} needs about ${c.power.needed} worlds.`);
  L.push("", `Brain \`${cand.identity.brain.slice(0, 8)}\` · body \`${cand.identity.body.slice(0, 8)}\` · suite \`${cand.identity.suite.slice(0, 8)}\` · ${cand.environment.evaluator} · ${cand.environment.platform}`);
  if (reproduce) L.push("", `Reproduce: \`${reproduce}\``);
  return L.join("\n") + "\n";
}

/** A first run with no baseline: what this version does, without a verdict. */
export function summaryReport(e: Evidence): string {
  const failing = e.episodes.filter((x) => x.status !== "success").map((x) => `${x.seed}${x.status !== "failure" ? ` (${x.status})` : ""}`);
  return [`### Ossilic · ${e.machine.name} · ${e.suite.name}`, "", `Success ${rate(e.summary)} · mean score ${e.summary.meanScore ?? "—"} · ${e.driver} · ${e.environment.platform}`, `Not passing: ${failing.length ? failing.slice(0, 15).join(", ") + (failing.length > 15 ? ` and ${failing.length - 15} more` : "") : "none"}`, ...trustFacts(e).map((x) => `- ${x}`)].join("\n") + "\n";
}
