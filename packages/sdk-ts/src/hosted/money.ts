/**
 * HOW SPEND MAY BE STATED — one rule, read by everything that shows a user a
 * number.
 *
 * The API serves each money figure with a LANE beside it (`spend_source`,
 * `judge_spend_source`, and at job level the count of trials the total cannot
 * account for). The pair is the honest statement: the lane says how final the
 * figure is. Every surface that shows the number WITHOUT the lane has to decide
 * on its own what an unfinal figure looks like, and the wrong answer is always
 * the same one — print it bare, and "nobody measured this" becomes the sentence
 * "this cost $0.00".
 *
 * That had already happened four times on this side of the wire: Harbor's
 * `result.json`, which has no slot for a lane; `evolve trial show`'s money row;
 * the trial list's SPENT column; and the judge row directly under the first of
 * them. So the rule lives here, once, and they all read it.
 *
 * Three lanes, three statements:
 *
 *   measured             a figure. The gateway read it, and past the platform's
 *                        confirmation window it will not move again.
 *   measured_provisional a FLOOR. A reading taken inside the gateway's async
 *                        spend flush is a lower bound on a total still being
 *                        written; asking again later can only ever find more.
 *   assumed_cap          nothing may be stated. Nobody measured this spend —
 *                        either no reading was taken or one was taken that
 *                        proved nothing — and the number the column happens to
 *                        hold is not evidence of anything.
 *
 * ...and one refusal inside the measured lane itself, for the row whose stamp
 * cannot be trusted — see `unevidencedMeasuredZero`.
 */
import type { SpendSource, Trial } from "./types";

/** How one spend figure may be stated to a reader. */
export type SpendStatement =
  /** The gateway read it, and the reading is final. */
  | { lane: "measured"; usd: number }
  /** A lower bound on a total still being written. */
  | { lane: "floor"; usd: number }
  /** No figure may be stated: nobody measured this. */
  | { lane: "unmeasured" };

/**
 * A "measured" $0 that names NO token evidence — not an authoritative figure,
 * whatever produced it.
 *
 * The money and the tokens come from one and the same gateway read (the
 * platform's settle says so in those words), so a real measured zero always
 * arrives with its token trace. A row without one is either a zero that was
 * PROVEN rather than read — a pre-run infrastructure failure, no key ever
 * minted — or a window the gateway lost and the platform stamped anyway. These
 * fields cannot tell those apart, which is exactly why neither may be stated as
 * a cost.
 *
 * The same columns and the same verdict as the platform's own reader (its
 * money.ts `isImpossibleMeasuredZero`, applied wherever it writes a Harbor
 * result.json). Restated here rather than shared because the rule lives on the
 * other side of the wire; every input rides the public trial shape, so the
 * client reaches the identical answer.
 */
function unevidencedMeasuredZero(
  source: SpendSource | null | undefined,
  usd: number,
  tokens: Array<number | null | undefined>,
): boolean {
  return source === "measured" && usd === 0 && tokens.every((count) => (count ?? null) === null);
}

/** The lane rule itself, over one figure and the evidence beside it. */
function statement(
  usd: number | null | undefined,
  source: SpendSource | null | undefined,
  tokens: Array<number | null | undefined>,
): SpendStatement {
  if (typeof usd !== "number" || !Number.isFinite(usd)) return { lane: "unmeasured" };
  if (source === "measured") {
    return unevidencedMeasuredZero(source, usd, tokens)
      ? { lane: "unmeasured" }
      : { lane: "measured", usd };
  }
  if (source === "measured_provisional") return { lane: "floor", usd };
  return { lane: "unmeasured" };
}

/**
 * What this trial's AGENT spend may be stated as. A trial that never executed
 * carries no `agent_result` at all and is `unmeasured` here too — "no figure"
 * is the honest answer for it as well.
 */
export function trialAgentCost(trial: Trial): SpendStatement {
  const result = trial.agent_result;
  return statement(result?.cost_usd, trial.spend_source, [
    result?.n_input_tokens,
    result?.n_cache_tokens,
    result?.n_output_tokens,
  ]);
}

/**
 * What this trial's JUDGE spend may be stated as — the same rule over the same
 * shape one lane across. The judge key seals through the platform's identical
 * settle, so it reaches `assumed_cap` for the identical reason and at the
 * identical moment: a verdict written before the gateway's spend log caught up.
 */
export function trialJudgeCost(trial: Trial): SpendStatement {
  const result = trial.judge_result;
  return statement(result?.cost_usd, trial.judge_spend_source, [
    result?.n_input_tokens,
    result?.n_cache_tokens,
    result?.n_output_tokens,
  ]);
}

/**
 * A JOB total is a different kind of unfinal, and says so differently.
 *
 * `stats.cost_usd` is the sum of its trials, so it is real metered money — but
 * every trial nobody measured folded a ZERO into it, which makes the total a
 * floor rather than a fabrication. The wire says how many: `n_unmeasured_trials`
 * exists precisely to state that "cost_usd comes out LOWER than what was really
 * spent". A freshly finished job is normally in that state for its first few
 * minutes, so the qualifier is the common case, not the exotic one.
 *
 * ONE-WAY, AND SAY SO: a positive count proves the total cannot ACCOUNT for
 * every trial, which is what "at least" claims and all it claims — the sum may
 * still happen to be exact, if a trial nobody measured really did spend
 * nothing. The converse does not hold: trials still in the provisional lane
 * fold floors in too and the wire carries no count of those, so a plain figure
 * here means "no shortfall we can prove", never "final". Absent counters
 * (older servers) take that same plain reading, since absence is not zero.
 */
export function jobSpend(
  costUsd: number | null | undefined,
  unmeasuredTrials: number | null | undefined,
): SpendStatement {
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd)) return { lane: "unmeasured" };
  return typeof unmeasuredTrials === "number" && unmeasuredTrials > 0
    ? { lane: "floor", usd: costUsd }
    : { lane: "measured", usd: costUsd };
}

/**
 * The FRESHEST statement of the agent's spend: the settled statement when one
 * exists, else the live floor from the one-home usage reading while the trial
 * is still being metered.
 *
 * A RUNNING trial has no `agent_result` yet, so trialAgentCost() honestly says
 * `unmeasured` — but the platform's live poll is already publishing a lower
 * bound under `usage`, and a list that prints "-" beside a run that has
 * demonstrably spent money states less than the wire knows. The floor idiom
 * ("at least $X") is exactly the right sentence for it, and it is the SAME
 * sentence a `measured_provisional` settle earns — one idiom for every kind of
 * lower bound. The settled statement always wins the moment it exists; a
 * usage reading that is not provisional but produced no settled statement
 * adds nothing (that combination does not occur on the wire) and is refused
 * rather than promoted.
 */
export function trialSpendNow(trial: Trial): SpendStatement {
  const settled = trialAgentCost(trial);
  if (settled.lane !== "unmeasured") return settled;
  const usage = trial.usage;
  if (usage && usage.provisional && typeof usage.spent_usd === "number") {
    return { lane: "floor", usd: usage.spent_usd };
  }
  return settled;
}
