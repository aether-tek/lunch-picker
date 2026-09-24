// ============================================================
// Firestore 資料層：取代 Apps Script 後端。
// 對外只有 get(params) / post(body) 兩個函式，action 名稱、參數與回傳格式
// 與 Code.gs 的 doGet / doPost 完全相同，index.html 的 UI 程式碼因此幾乎不用動。
//
// 本機測試：網址加上 ?emulator=1 會改連本機 emulator（firestore 8085 / auth 9099）。
// ============================================================

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, connectFirestoreEmulator,
  collection, doc, getDoc, getDocs, setDoc, deleteDoc, updateDoc, writeBatch, query, where, orderBy,
  serverTimestamp, arrayUnion, arrayRemove
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import {
  getAuth, connectAuthEmulator, GoogleAuthProvider, signInWithPopup
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { firebaseConfig } from './firebase-config.js';
import { computeRanking, taipeiDateStr, taipeiTimestampStr, taipeiHourMin, TZ } from './ranking.js';

const useEmulator = new URLSearchParams(location.search).has('emulator');
const app = initializeApp(useEmulator ? { ...firebaseConfig, projectId: 'demo-lunch' } : firebaseConfig);
// 本機持久快取：重新整理後先從 IndexedDB 秒開，再背景同步
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});
const auth = getAuth(app);
if (useEmulator) {
  connectFirestoreEmulator(db, '127.0.0.1', 8085);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
}

// ── 常數（與 Code.gs 相同） ─────────────────────────────
const PREF_CUTOFF_HOUR = 12;
const PREF_CUTOFF_MIN = 0;
const EXCLUDE_WORKDAYS_DEFAULT = 7;
const EXCLUDE_WORKDAYS_MIN = 3;
const EXCLUDE_WORKDAYS_MAX = 20;
const COMMENT_MAX_LENGTH = 150;

// ── 工具 ─────────────────────────────────────────────
const docId = s => encodeURIComponent(String(s).trim());
const isReservedUser = name => !!name && String(name).trim().toLowerCase() === 'admin';
const todayStr = () => taipeiDateStr();

// ── 讀取（對應 Code.gs 的 getXxx） ─────────────────────
async function getRestaurants() {
  const snap = await getDocs(query(collection(db, 'restaurants'), orderBy('createdAt')));
  return snap.docs.map(d => d.data().name).filter(Boolean);
}

async function getPreferences(person) {
  if (person) {
    const snap = await getDoc(doc(db, 'preferences', docId(person)));
    return snap.exists() ? orderToRanks(snap.data().order) : {};
  }
  const snap = await getDocs(collection(db, 'preferences'));
  const result = {};
  snap.docs.forEach(d => {
    const { person: p, order } = d.data();
    if (!isReservedUser(p)) result[p] = orderToRanks(order);
  });
  return result;
}
const orderToRanks = order => Object.fromEntries((order || []).map((rest, i) => [rest, i + 1]));

async function getPersonList() {
  return Object.keys(await getPreferences(null)).sort();
}

async function getAttendance(dateStr) {
  const snap = await getDoc(doc(db, 'attendance', dateStr || todayStr()));
  const result = {};
  if (snap.exists()) {
    Object.entries(snap.data()).forEach(([p, v]) => { if (!isReservedUser(p)) result[p] = v === true; });
  }
  return result;
}

async function getHistory() {
  const snap = await getDocs(collection(db, 'history'));
  const result = {};
  snap.docs.forEach(d => { result[d.id] = d.data().restaurant; });
  return result;
}

async function getComments() {
  const snap = await getDocs(collection(db, 'comments'));
  const result = {};
  snap.docs.forEach(d => {
    const { restaurant, person, comment, updatedAt } = d.data();
    if (!restaurant || !person || !comment || isReservedUser(person)) return;
    (result[restaurant] ||= []).push({ person, comment, updated_at: updatedAt || '' });
  });
  Object.values(result).forEach(list => list.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')));
  return result;
}

async function getCommentsByPerson(person) {
  const snap = await getDocs(query(collection(db, 'comments'), where('person', '==', person)));
  const result = {};
  snap.docs.forEach(d => { const { restaurant, comment } = d.data(); if (comment) result[restaurant] = comment; });
  return result;
}

async function getSettings() {
  const snap = await getDoc(doc(db, 'config', 'settings'));
  const data = snap.exists() ? snap.data() : {};
  const n = parseInt(data.excludeWorkdays, 10);
  return {
    excludeWorkdays: (isNaN(n) || n < EXCLUDE_WORKDAYS_MIN || n > EXCLUDE_WORKDAYS_MAX) ? EXCLUDE_WORKDAYS_DEFAULT : n,
    overrideDate: data.overrideDate === todayStr() ? data.overrideDate : null   // 非今天 → 視為過期
  };
}

async function hasTodayHistory() {
  const snap = await getDoc(doc(db, 'history', todayStr()));
  return snap.exists() && !!snap.data().restaurant;
}

// 前端顯示用；真正的強制檢查在 firestore.rules（用伺服器時間，改電腦時間繞不過）
async function isPreferenceLocked(settings, todayLogged) {
  settings = settings || await getSettings();
  if (todayLogged ?? await hasTodayHistory()) return false;
  if (settings.overrideDate) return false;
  const { hour, minute } = taipeiHourMin();
  return hour > PREF_CUTOFF_HOUR || (hour === PREF_CUTOFF_HOUR && minute >= PREF_CUTOFF_MIN);
}

async function getPreferenceLockStatus() {
  const [settings, todayLogged] = await Promise.all([getSettings(), hasTodayHistory()]);
  return {
    locked: await isPreferenceLocked(settings, todayLogged),
    todayLogged,
    adminOverride: !!settings.overrideDate,
    excludeDays: settings.excludeWorkdays,
    excludeDaysMin: EXCLUDE_WORKDAYS_MIN,
    excludeDaysMax: EXCLUDE_WORKDAYS_MAX,
    serverTime: taipeiTimestampStr(),
    cutoffHour: PREF_CUTOFF_HOUR,
    cutoffMin: PREF_CUTOFF_MIN,
    timezone: TZ
  };
}

async function getRanking(deps = {}) {
  const [restaurants, allPrefs, attendance, history, settings] = await Promise.all([
    deps.restaurants || getRestaurants(),
    deps.allPrefs || getPreferences(null),
    deps.attendance || getAttendance(todayStr()),
    deps.history || getHistory(),
    deps.settings || getSettings()
  ]);
  return computeRanking({
    restaurants, allPrefs: structuredClone(allPrefs), attendance, history,
    excludeDays: settings.excludeWorkdays
  });
}

async function getRankingPageData() {
  // 全部平行讀取（舊版是循序讀 5 張表）
  const [restaurants, allPrefs, attendance, history, comments, settings] = await Promise.all([
    getRestaurants(), getPreferences(null), getAttendance(todayStr()), getHistory(), getComments(), getSettings()
  ]);
  const ranking = await getRanking({ restaurants, allPrefs, attendance, history, settings });
  return { ranking, comments, history, today: todayStr() };
}

async function getPrefsPageData(person) {
  const [preferences, comments, lockStatus] = await Promise.all([
    getPreferences(person), getComments(), getPreferenceLockStatus()
  ]);
  return { preferences, comments, lockStatus, today: todayStr() };
}

// ── 寫入（對應 Code.gs 的 doPost actions） ─────────────
async function addRestaurant(name) {
  if (!name || !name.trim()) return { success: false, error: '名稱不能為空' };
  const trimmed = name.trim();
  const ref = doc(db, 'restaurants', docId(trimmed));
  if ((await getDoc(ref)).exists()) return { success: false, error: '餐廳已存在' };
  await setDoc(ref, { name: trimmed, createdAt: serverTimestamp() });

  // 自動把新餐廳補進所有現有使用者偏好的最後一名（對應 autoAppendNewRestaurantToAllUsers）
  const prefs = await getDocs(collection(db, 'preferences'));
  const batch = writeBatch(db);
  let n = 0;
  prefs.docs.forEach(d => {
    const { person, order } = d.data();
    if (isReservedUser(person) || (order || []).includes(trimmed)) return;
    batch.update(d.ref, { order: arrayUnion(trimmed), updatedAt: serverTimestamp() });
    n++;
  });
  if (n) await batch.commit();
  return { success: true };
}

async function deleteRestaurant(name) {
  if (!name) return { success: false, error: '名稱不能為空' };
  const ref = doc(db, 'restaurants', docId(name));
  if (!(await getDoc(ref)).exists()) return { success: false, error: '找不到此餐廳' };

  // 連帶清除偏好與評論，全部放在同一個 batch 一次寫入
  const [prefs, comments] = await Promise.all([
    getDocs(collection(db, 'preferences')),
    getDocs(query(collection(db, 'comments'), where('restaurant', '==', name)))
  ]);
  const batch = writeBatch(db);
  batch.delete(ref);
  prefs.docs.forEach(d => {
    if ((d.data().order || []).includes(name)) {
      batch.update(d.ref, { order: arrayRemove(name), updatedAt: serverTimestamp() });
    }
  });
  comments.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
  return { success: true };
}

async function savePreferences(person, orderedRestaurants) {
  if (!person) return { success: false, error: '缺少使用者名稱' };
  if (isReservedUser(person)) return { success: false, error: 'admin 不參與偏好設定' };
  if (!Array.isArray(orderedRestaurants)) return { success: false, error: '參數格式錯誤' };
  if (await isPreferenceLocked()) {
    return { success: false, error: `每日 ${PREF_CUTOFF_HOUR}:00 後無法調整偏好，明天再來` };
  }
  const allRestaurants = await getRestaurants();
  if (orderedRestaurants.length < allRestaurants.length - 1) {
    return {
      success: false,
      error: `偏好清單不完整（送出 ${orderedRestaurants.length} 筆 / 應有 ${allRestaurants.length} 筆），已拒絕儲存。請重新整理頁面再試。`
    };
  }
  await setDoc(doc(db, 'preferences', docId(person)), {
    person, order: orderedRestaurants, updatedAt: serverTimestamp()
  });
  return { success: true, saved: orderedRestaurants.length };
}

async function setAttendance(person, attending) {
  if (!person) return { success: false, error: '請輸入名字' };
  if (isReservedUser(person)) return { success: false, error: 'admin 不參與午餐' };
  // 只更新自己的欄位，不會覆蓋別人；舊日期的文件留著不用清
  await setDoc(doc(db, 'attendance', todayStr()), { [person]: !!attending }, { merge: true });
  return { success: true, ranking: await getRanking() };
}

async function recordHistory(restaurant) {
  if (restaurant === undefined || restaurant === null) return { success: false, error: '請選擇餐廳' };
  const ref = doc(db, 'history', todayStr());
  if (restaurant === '__clear__') {
    await deleteDoc(ref);
    return { success: true, cleared: true };
  }
  if (!restaurant) return { success: false, error: '請選擇餐廳' };
  await setDoc(ref, { restaurant });
  return { success: true };
}

async function saveComment(person, restaurant, comment) {
  if (!person || !restaurant) return { success: false, error: '參數不完整' };
  if (isReservedUser(person)) return { success: false, error: 'admin 不寫評論' };
  const trimmed = (comment || '').trim();
  if (trimmed.length > COMMENT_MAX_LENGTH) return { success: false, error: `評論最多 ${COMMENT_MAX_LENGTH} 字` };
  const ref = doc(db, 'comments', `${docId(restaurant)}__${docId(person)}`);
  if (trimmed === '') {
    await deleteDoc(ref);
  } else {
    await setDoc(ref, { restaurant, person, comment: trimmed, updatedAt: taipeiTimestampStr() });
  }
  return { success: true };
}

// ── admin：Google 登入 + firestore.rules 的 admins/{uid} 白名單 ──
async function requireAdminSignIn() {
  if (!auth.currentUser) await signInWithPopup(auth, new GoogleAuthProvider());
}

async function writeSettings(patch) {
  await requireAdminSignIn();
  const current = await getSettings();
  const next = { excludeWorkdays: current.excludeWorkdays, overrideDate: current.overrideDate || '', ...patch };
  await setDoc(doc(db, 'config', 'settings'), next);
  return next;
}

async function setExcludeWorkdays(days) {
  const n = parseInt(days, 10);
  if (isNaN(n) || n < EXCLUDE_WORKDAYS_MIN || n > EXCLUDE_WORKDAYS_MAX) {
    return { success: false, error: `天數必須介於 ${EXCLUDE_WORKDAYS_MIN} ~ ${EXCLUDE_WORKDAYS_MAX}` };
  }
  await writeSettings({ excludeWorkdays: n });
  return { success: true, days: n };
}

async function enableAdminOverride() {
  await writeSettings({ overrideDate: todayStr() });
  return { success: true, enabled: true, date: todayStr() };
}

async function disableAdminOverride() {
  await writeSettings({ overrideDate: '' });
  return { success: true, enabled: false };
}

// ── 路由（與 Code.gs doGet / doPost 相同的 action 名稱） ─
// Firestore 權限錯誤轉成舊版的 { success:false, error } 格式，UI 的錯誤處理不用改
function friendlyError(err) {
  if (err?.code === 'permission-denied') return '沒有權限執行此操作（可能已超過 12:00 鎖定時間，或不是管理員帳號）';
  if (err?.code === 'auth/popup-closed-by-user') return '已取消管理員登入';
  return err?.message || String(err);
}

export async function get(params) {
  const p = params || {};
  try {
    switch (p.action) {
      case 'getRestaurants':     return await getRestaurants();
      case 'getPreferences':     return await getPreferences(p.person);
      case 'getAttendance':      return await getAttendance(p.date || todayStr());
      case 'getHistory':         return await getHistory();
      case 'getRanking':         return await getRanking();
      case 'getPersonList':      return await getPersonList();
      case 'getComments':        return await getComments();
      case 'getMyComments':      return await getCommentsByPerson(p.person);
      case 'getPrefLockStatus':  return await getPreferenceLockStatus();
      case 'getRankingPageData': return await getRankingPageData();
      case 'getPrefsPageData':   return await getPrefsPageData(p.person);
      default: return { error: 'Unknown action' };
    }
  } catch (err) {
    console.error('[data.get]', p.action, err);
    return { error: friendlyError(err) };
  }
}

export async function post(body) {
  const b = body || {};
  try {
    switch (b.action) {
      case 'addRestaurant':        return await addRestaurant(b.name);
      case 'deleteRestaurant':     return await deleteRestaurant(b.name);
      case 'savePreferences':      return await savePreferences(b.person, b.orderedRestaurants);
      case 'setAttendance':        return await setAttendance(b.person, b.attending);
      case 'recordHistory':        return await recordHistory(b.restaurant);
      case 'saveComment':          return await saveComment(b.person, b.restaurant, b.comment);
      case 'enableAdminOverride':  return await enableAdminOverride();
      case 'disableAdminOverride': return await disableAdminOverride();
      case 'setExcludeWorkdays':   return await setExcludeWorkdays(b.days);
      default: return { error: 'Unknown action' };
    }
  } catch (err) {
    console.error('[data.post]', b.action, err);
    return { success: false, error: friendlyError(err) };
  }
}
