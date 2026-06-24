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

  return {
    rows,
    totals: {
      total, staffBudget, powerBudget, partBudget,
      staffSum, powerSum, partSum, distributed,
      remaining: total - distributed,
    },
    byTier,
    tierCount,
    verification: {
      ok: distributed <= total,
      remaining: total - distributed,
      shortage: Math.max(0, distributed - total),
      status: distributed <= total ? '정상' : '초과',
    },
  };
}

/** Suggested participation score from a per-member content attendance map.
 *  attendance: { [contentName]: count }. catalog: [{name, points, weekly}]. */
export function scoreFromAttendance(attendance, catalog) {
  let s = 0;
  for (const c of catalog) {
    const n = Math.min(attendance[c.name] || 0, c.weekly || Infinity);
    s += n * (c.points || 0);
  }
  return s;
}

/** Max possible weekly participation score from the catalog. */
export function maxWeeklyScore(catalog) {
  return catalog.reduce((s, c) => s + (c.points || 0) * (c.weekly || 0), 0);
}
