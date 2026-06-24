// calc.js — Diamond settlement engine. Faithful re-implementation of the
// 다이아 계산 시트 (명단 + 설정 + 운영진 → 최종정산). Pure functions, no DOM.
// Verified to reproduce the source sheet to the diamond.

/** Assign participation tier from score using descending-minScore tier cuts. */
export function tierForScore(score, tiers) {
  // tiers expected sorted desc by minScore; fall back to last (F)
  for (const t of tiers) if (score >= t.minScore) return t.tier;
  return tiers.length ? tiers[tiers.length - 1].tier : 'F';
}

const round = (n) => Math.round(n);

/**
 * Compute the full clan diamond settlement.
 * @param {object} data { members, settings, tiers, powerRanks, staff }
 * @returns {object} { rows, totals, byTier, verification }
 *   rows: per-member { id, name, cls, power, powerRank, score, tier,
 *                      powerDia, partDia, staffDia, total }
 */
export function computeSettlement(data) {
  const { settings, tiers } = data;
  const members = (data.members || []).filter((m) => m.active !== false);
  const staff = data.staff || [];
  const powerRanks = data.powerRanks || [];

  const total = settings.totalDiamonds || 0;
  const staffBudget = round(total * (settings.staffRatio || 0));
  const powerBudget = round(total * (settings.powerRatio || 0));
  const partBudget = round(total * (settings.participationRatio || 0));

  // --- combat-power ranking (desc by power); ties broken by current order ---
  const ranked = [...members].sort((a, b) => (b.power - a.power) || (a.order - b.order));
  const rankOf = new Map();
  ranked.forEach((m, i) => rankOf.set(m.id, i + 1));
  const powerPctByRank = new Map(powerRanks.map((p) => [p.rank, p.pct]));

  // --- participation tier counts & per-tier unit ---
  const tierCount = {};
  for (const m of members) {
    const t = tierForScore(m.score || 0, tiers);
    tierCount[t] = (tierCount[t] || 0) + 1;
  }
  const multOf = Object.fromEntries(tiers.map((t) => [t.tier, t.mult]));
  let denom = 0;
  for (const t of tiers) denom += (t.mult || 0) * (tierCount[t.tier] || 0);
  const unit = denom > 0 ? partBudget / denom : 0;
  const partDiaByTier = {};
  for (const t of tiers) partDiaByTier[t.tier] = round((t.mult || 0) * unit);

  // --- staff payout (proportional to ratio; equal split when ratios equal) ---
  const staffRatioSum = staff.reduce((s, x) => s + (x.ratio || 0), 0);
  const staffDiaOf = new Map();
  for (const s of staff) {
    const d = staffRatioSum > 0 ? round(staffBudget * (s.ratio || 0) / staffRatioSum)
                                : round(staffBudget / (staff.length || 1));
    staffDiaOf.set(s.name, d);
  }

  // --- assemble rows ---
  const rows = members.map((m) => {
    const powerRank = rankOf.get(m.id);
    const powerPct = powerPctByRank.get(powerRank) || 0;
    const powerDia = round(total * powerPct);
    const tier = tierForScore(m.score || 0, tiers);
    const partDia = partDiaByTier[tier] || 0;
    const staffDia = staffDiaOf.get(m.name) || 0;
    return {
      id: m.id, name: m.name, cls: m.cls, power: m.power,
      powerRank, score: m.score || 0, tier,
      powerDia, partDia, staffDia,
      total: powerDia + partDia + staffDia,
    };
  });
  rows.sort((a, b) => b.total - a.total);

  // --- totals & verification ---
  const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
  const staffSum = sum('staffDia');
  const powerSum = sum('powerDia');
  const partSum = sum('partDia');
  const distributed = staffSum + powerSum + partSum;
  const byTier = tiers.map((t) => ({
    tier: t.tier, mult: t.mult, count: tierCount[t.tier] || 0,
    each: partDiaByTier[t.tier] || 0, subtotal: (partDiaByTier[t.tier] || 0) * (tierCount[t.tier] || 0),
  }));

  // Per-tier rounding (required by "같은 티어 동일 지급") makes an exact budget
  // match generally impossible — the source 시트 also drifts a few diamonds and
  // reports 남는/모자른. Tolerate drift up to ~1 diamond per member.
  const remaining = total - distributed;          // +면 남는, -면 모자른
  const tol = Math.max(10, members.length);
  return {
    rows,
    totals: {
      total, staffBudget, powerBudget, partBudget,
      staffSum, powerSum, partSum, distributed,
      remaining, surplus: Math.max(0, remaining), shortage: Math.max(0, -remaining),
    },
    byTier,
    tierCount,
    verification: {
      ok: Math.abs(remaining) <= tol,
      remaining,
      surplus: Math.max(0, remaining),
      shortage: Math.max(0, -remaining),
      status: Math.abs(remaining) <= tol ? '정상' : (remaining < 0 ? '초과(조정 필요)' : '잔여 많음'),
    },
  };
}

/** Participation score for a member from the date-based event log.
 *  byDate: { 'YYYY-MM-DD': { [content]: [memberId,...] } }. range: {from,to} (inclusive, optional). */
export function scoreForMember(byDate, catalog, memberId, range = {}) {
  const pts = Object.fromEntries(catalog.map((c) => [c.name, c.points || 0]));
  const { from, to } = range;
  let s = 0;
  for (const date of Object.keys(byDate)) {
    if (from && date < from) continue;
    if (to && date > to) continue;
    const day = byDate[date];
    for (const content of Object.keys(day)) {
      if (day[content].includes(memberId)) s += pts[content] || 0;
    }
  }
  return s;
}

/** Map of memberId -> participation score over a date range. */
export function computeScores(byDate, catalog, members, range = {}) {
  const out = {};
  for (const m of members) out[m.id] = scoreForMember(byDate, catalog, m.id, range);
  return out;
}

/** How many distinct participations a member has in a date range (for activity display). */
export function attendanceCount(byDate, memberId, range = {}) {
  const { from, to } = range;
  let n = 0;
  for (const date of Object.keys(byDate)) {
    if (from && date < from) continue;
    if (to && date > to) continue;
    for (const ids of Object.values(byDate[date])) if (ids.includes(memberId)) n++;
  }
  return n;
}
