// ============================================================
// 排名計算（純函式，無 I/O）—— 從 Code.gs 的 getRanking / rankToScore /
// getRecentWeekdayMeals 逐行搬過來，行為必須與舊版一致。
// tests/ranking-parity.mjs 會拿同一份資料同時跑這裡和 Code.gs 原版比對。
// ============================================================

export const TZ = 'Asia/Taipei';

// 台北時間 yyyy-MM-dd（取代 Utilities.formatDate(date, tz, 'yyyy-MM-dd')）
export function taipeiDateStr(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(date);
}

// 台北時間 yyyy-MM-dd HH:mm:ss
export function taipeiTimestampStr(date = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

// 台北時間的 { hour, minute }
export function taipeiHourMin(date = new Date()) {
  const [h, m] = taipeiTimestampStr(date).slice(11, 16).split(':').map(Number);
  return { hour: h, minute: m };
}

/**
 * 把名次轉成分數，線性 0 ~ 10 分。第 1 名 = 10 分，最後一名 = 0 分。
 */
export function rankToScore(rank, totalRestaurants) {
  if (totalRestaurants <= 1) return 10;
  return 10 * (totalRestaurants - rank) / (totalRestaurants - 1);
}

/**
 * 從今天往回找 N 個「上班日」（週一至週五，以台北日期計），回傳這幾天吃過的餐廳集合。
 * 包含今天（如果今天是上班日）。最多回看 30 個自然日。
 */
export function getRecentWeekdayMeals(workdayCount, history, now = new Date()) {
  const excluded = new Set();
  // 以台北日期為起點，用 UTC 日曆逐日往回走，避免本機時區影響星期判斷
  const [y, m, d] = taipeiDateStr(now).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  let collected = 0;
  for (let i = 0; i < 30 && collected < workdayCount; i++) {
    const day = date.getUTCDay();
    if (day >= 1 && day <= 5) {
      const ds = date.toISOString().slice(0, 10);
      if (history[ds]) excluded.add(history[ds]);
      collected++;
    }
    date.setUTCDate(date.getUTCDate() - 1);
  }
  return excluded;
}

/**
 * 計算今日排名。
 * @param {Object} deps
 *   restaurants  string[]                      現存餐廳（依建立順序）
 *   allPrefs     { person: { rest: rank } }    所有人的偏好（會被正規化，請傳副本）
 *   attendance   { person: boolean }           今天的出席
 *   history      { 'yyyy-MM-dd': rest }        歷史
 *   excludeDays  number                        不重複過濾的上班日數
 *   now          Date                          （測試用）現在時間
 */
export function computeRanking({ restaurants, allPrefs, attendance, history, excludeDays, now = new Date() }) {
  const totalRest = restaurants.length;

  const participants = Object.keys(attendance).filter(p => attendance[p]);
  const n = participants.length;

  if (n === 0) {
    return { participants: [], ranking: [], message: '今天還沒有人加入午餐' };
  }

  // 檢查每個出席者是否有完整偏好設定
  const missingPrefs = [];
  participants.forEach(person => {
    const personPrefs = allPrefs[person] || {};
    const missing = restaurants.filter(r => !personPrefs[r]);
    if (missing.length > 0) {
      missingPrefs.push({ person: person, missingCount: missing.length });
    }
  });

  if (missingPrefs.length > 0) {
    const names = missingPrefs.map(m => m.person).join('、');
    return {
      participants,
      ranking: [],
      missingPrefs: missingPrefs,
      message: `${names} 還沒設定完整偏好，請先到「我的偏好」頁面把每家餐廳排好順序`
    };
  }

  // 把每個出席者的名次壓成連續的 1..N（只看目前存在的餐廳，依原本相對順序）
  participants.forEach(person => {
    const personPrefs = allPrefs[person];
    const ordered = restaurants.slice().sort((a, b) => personPrefs[a] - personPrefs[b]);
    const normalized = {};
    ordered.forEach((rest, idx) => { normalized[rest] = idx + 1; });
    allPrefs[person] = normalized;
  });

  // 硬性過濾：最近 N 個上班日吃過的店一律排除
  const excluded = getRecentWeekdayMeals(excludeDays, history, now);

  const results = [];

  restaurants.forEach(rest => {
    if (excluded.has(rest)) return;

    let total = 0;
    const breakdown = [];
    participants.forEach(person => {
      const rank = allPrefs[person][rest];
      const score = rankToScore(rank, totalRest);
      total += score;
      breakdown.push({
        person: person,
        rank: rank,
        score: Math.round(score * 100) / 100
      });
    });

    const avgScore = total / n;

    results.push({
      restaurant: rest,
      finalScore: Math.round(avgScore * 100) / 100,
      avgScore: Math.round(avgScore * 100) / 100,
      breakdown: breakdown,
      total: Math.round(total * 100) / 100
    });
  });

  results.sort((a, b) => b.finalScore - a.finalScore);

  const message = results.length === 0
    ? `所有候選餐廳在最近 ${excludeDays} 個上班日都吃過了 — 試著新增餐廳，或等過幾天再看`
    : undefined;

  return { participants, ranking: results, excluded: Array.from(excluded), excludeDays, message };
}
