const express = require("express");
const admin = require("firebase-admin");
const crypto = require("crypto");
const path = require("path");

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "100kb" }));
app.use(express.static(path.join(__dirname)));
app.get("/admin", (_req, res) => res.sendFile(path.join(__dirname, "admin.html")));

const PORT = process.env.PORT || 3000;
const MCH_ID = String(process.env.NEKPAY_MCH_ID || "808258224");
const API_SECRET = process.env.NEKPAY_PAYMENT_KEY;
const BASE_URL = (process.env.NEKPAY_API_URL || "").replace(/\/$/, "");
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");

if (!API_SECRET) console.warn("WARNING: NEKPAY_PAYMENT_KEY is missing");
if (!PUBLIC_URL) console.warn("WARNING: PUBLIC_URL is missing");
if (!admin.apps.length) {
  let serviceAccount;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } else {
    serviceAccount = {
      project_id: process.env.FIREBASE_PROJECT_ID,
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      private_key: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n")
    };
  }
  if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) {
    throw new Error("Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY");
  }
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
}
const db = admin.database();

// অ্যাডমিন যাচাই: শুধু ADMIN_UIDS-এ থাকা Firebase UID-রাই অ্যাডমিন API ব্যবহার করতে পারবে।
const ADMIN_UID_SET = new Set((process.env.ADMIN_UIDS || "").split(",").map(s => s.trim()).filter(Boolean));
async function requireAdmin(req, res, next) {
  try {
    const header = String(req.headers.authorization || "");
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) return res.status(401).json({ message: "আগে অ্যাডমিন হিসেবে লগইন করুন" });
    const decoded = await admin.auth().verifyIdToken(token);
    if (!ADMIN_UID_SET.has(decoded.uid)) return res.status(403).json({ message: "এই অ্যাকাউন্টের অ্যাডমিন অনুমতি নেই" });
    req.adminUid = decoded.uid;
    return next();
  } catch (e) {
    return res.status(401).json({ message: "সেশন যাচাই ব্যর্থ, আবার লগইন করুন" });
  }
}

function methodCode(method) {
  return ({ bkash: "BKASH", nagad: "NAGAD", rocket: "ROCKET" })[String(method || "").toLowerCase()];
}
function validPhone(phone) { return /^01[3-9]\d{8}$/.test(String(phone || "")); }

// রেফারেল কোডের প্রথম ৩ অক্ষর "SPL" স্থায়ী; এটি বদলানো যাবে না।
const REFERRAL_PREFIX = "SPL";
async function makeReferralCode(requested) {
  const useRequested = /^SPL\d{5}$/.test(requested);
  for (let attempt = 0; attempt < 30; attempt++) {
    const code = (useRequested && attempt === 0)
      ? requested
      : REFERRAL_PREFIX + String(Math.floor(10000 + Math.random() * 90000));
    const taken = await db.ref("users").orderByChild("referralCode").equalTo(code).once("value");
    if (!taken.exists()) return code;
  }
  throw new Error("রেফারেল কোড তৈরি করা যায়নি");
}


async function getSiteSettings() {
  const snap = await db.ref("site_settings").once("value");
  return snap.val() || {};
}

async function creditReferralCommissions(userPhone, baseAmount, sourceId) {
  const amount = Number(baseAmount);
  if (!Number.isFinite(amount) || amount <= 0 || !sourceId) return;
  const userSnap = await db.ref(`users/${userPhone}`).once("value");
  if (!userSnap.exists()) return;

  let parentCode = userSnap.val()?.invitedByCode || null;
  const settings = await getSiteSettings();
  const rates = (Array.isArray(settings.referral_commission_rates)
    ? settings.referral_commission_rates : [12, 2, 1])
    .slice(0, 3).map(v => Math.max(0, Number(v) || 0) / 100);

  for (let level = 0; level < rates.length && parentCode; level++) {
    const parentSnap = await db.ref("users").orderByChild("referralCode").equalTo(parentCode).once("value");
    const parents = parentSnap.val() || {};
    const parentPhone = Object.keys(parents)[0];
    if (!parentPhone) break;

    const commission = Number((amount * rates[level]).toFixed(2));
    if (commission > 0) {
      const claimRef = db.ref(`referral_commission_claims/${sourceId}/level${level + 1}`);
      const claim = await claimRef.transaction(current => current || {
        userPhone: parentPhone,
        sourceUserPhone: userPhone,
        amount,
        rate: rates[level] * 100,
        commission,
        createdAt: Date.now()
      });
      if (claim.committed && claim.snapshot.val()?.userPhone === parentPhone) {
        await db.ref(`users/${parentPhone}`).transaction(u => {
          if (!u) return;
          u.balance = Number(u.balance || 0) + commission;
          u.referralEarnings = Number(u.referralEarnings || 0) + commission;
          u.referralCommissionLog = u.referralCommissionLog || {};
          u.referralCommissionLog[`${sourceId}_L${level + 1}`] = {
            sourceId, sourceUserPhone: userPhone, level: level + 1,
            rate: rates[level] * 100, amount: commission, createdAt: Date.now()
          };
          return u;
        });
      }
    }
    parentCode = parents[parentPhone]?.invitedByCode || null;
  }
}

async function creditDueEarningsForUser(userPhone) {
  const userRef = db.ref(`users/${userPhone}`);
  const result = await userRef.transaction(user => {
    if (!user?.investments) return user;
    const nowMs = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    let changed = false;

    for (const [id, raw] of Object.entries(user.investments)) {
      const inv = raw || {};
      const daily = Number(inv.daily || 0);
      if (!Number.isFinite(daily) || daily <= 0) continue;

      const purchaseTime = Number(inv.purchaseTime || inv.createdAt || nowMs);
      const durationDays = Number(inv.duration || 0);
      const endTime = Number(inv.endTime || (durationDays > 0 ? purchaseTime + durationDays * dayMs : 0));
      let lastClaim = Number(inv.lastClaimTime || purchaseTime);
      if (lastClaim < purchaseTime) lastClaim = purchaseTime;

      if (endTime && lastClaim >= endTime) {
        inv.status = "completed";
        user.investments[id] = inv;
        continue;
      }

      const dueUntil = endTime ? Math.min(nowMs, endTime) : nowMs;
      const periods = Math.floor((dueUntil - lastClaim) / dayMs);
      if (periods <= 0) continue;

      const earned = Number((periods * daily).toFixed(2));
      const newLastClaim = lastClaim + periods * dayMs;

      user.balance = Number(user.balance || 0) + earned;
      inv.lastClaimTime = newLastClaim;
      inv.totalEarned = Number(inv.totalEarned || 0) + earned;
      inv.earningCount = Number(inv.earningCount || 0) + periods;
      if (endTime && newLastClaim >= endTime) inv.status = "completed";
      user.investments[id] = inv;

      user.earningLogs = user.earningLogs || {};
      for (let i = 1; i <= periods; i++) {
        const at = lastClaim + i * dayMs;
        const logKey = `${id}_${at}`;
        user.earningLogs[logKey] = {
          investmentId: id,
          packageId: inv.packageId || null,
          title: inv.title || "প্ল্যান",
          amount: daily,
          paidAt: at,
          source: "auto_24h"
        };
      }
      changed = true;
    }
    return user;
  });
  return !!result.committed;
}

async function processAllDueEarnings() {
  try {
    const snap = await db.ref("users").once("value");
    const users = snap.val() || {};
    for (const [phone, user] of Object.entries(users)) {
      try { await creditDueEarningsForUser(phone); } catch (e) { console.error("earning worker", phone, e); }
    }
  } catch (e) {
    console.error("earning worker failed:", e);
  }
}


app.post("/api/register", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const phone = String(req.body.phone || "").trim();
    const password = String(req.body.password || "").trim();
    const invitedByCode = String(req.body.invitedByCode || "").trim() || null;
    const deviceId = String(req.body.deviceId || "").trim();
    if (!name || !validPhone(phone) || password.length < 4) {
      return res.status(400).json({ message: "সঠিক নাম, মোবাইল নম্বর ও পাসওয়ার্ড দিন" });
    }
    const userRef = db.ref(`users/${phone}`);
    const exists = await userRef.once("value");
    if (exists.exists()) return res.status(409).json({ message: "এই মোবাইল নম্বর দিয়ে ইতিমধ্যে অ্যাকাউন্ট খোলা হয়েছে!" });

    const settings = await getSiteSettings();
    const bonus = Math.max(0, Number(settings.registration_bonus ?? 50));
    const requestedCode = String(req.body.referralCode || "").trim().toUpperCase();
    const referralCode = await makeReferralCode(requestedCode);
    const userData = {
      name, phone, password, referralCode, invitedByCode,
      balance: bonus, registrationBonus: bonus, spinTickets: 0, deviceId,
      purchasedCounts: {}, investments: {}, deposits: {}, withdrawals: {},
      claimed_codes: {}, timestamp: admin.database.ServerValue.TIMESTAMP
    };
    await userRef.set(userData);
    return res.json({ ok: true, bonus, referralCode });
  } catch (e) {
    console.error("registration error:", e);
    return res.status(500).json({ message: "নিবন্ধন করা যায়নি" });
  }
});


// NEKpay adapter is intentionally fail-closed until the merchant's official API
// specification is supplied. Do NOT guess request fields, signing rules or callback status.
app.post("/api/nekpay/collect", async (req, res) => {
  try {
    const userPhone = String(req.body.userPhone || "").trim();
    const amount = Number(req.body.amount);
    const method = methodCode(req.body.method);
    if (!validPhone(userPhone)) return res.status(400).json({ message: "সঠিক মোবাইল নম্বর পাওয়া যায়নি" });
    if (!Number.isFinite(amount) || amount < 1 || amount > 500000) return res.status(400).json({ message: "সঠিক পেমেন্ট পরিমাণ দিন" });
    if (!method) return res.status(400).json({ message: "সমর্থিত পেমেন্ট মেথড নির্বাচন করুন" });
    const userSnap = await db.ref(`users/${userPhone}`).once("value");
    if (!userSnap.exists()) return res.status(404).json({ message: "ইউজার অ্যাকাউন্ট পাওয়া যায়নি" });
    if (!API_SECRET || !MCH_ID || !BASE_URL || !PUBLIC_URL) {
      return res.status(503).json({ message: "NEKpay কনফিগারেশন অসম্পূর্ণ। Render Environment Variables যাচাই করুন।" });
    }
    return res.status(503).json({
      message: "NEKpay চালু করার আগে অফিসিয়াল Collect API Request/Response এবং Callback Signature নিয়ম যুক্ত করতে হবে। এখন কোনো টাকা কাটা বা ব্যালেন্স যোগ করা হবে না।"
    });
  } catch (e) {
    console.error("NEKpay collect error:", e);
    return res.status(500).json({ message: "পেমেন্ট শুরু করা যায়নি" });
  }
});

app.post("/api/nekpay/notify", async (_req, res) => {
  // Never credit user balance until official signature, merchant, order, amount,
  // paid status and one-time/idempotency validation are implemented.
  return res.status(503).send("NEKPAY_CALLBACK_NOT_CONFIGURED");
});

// অ্যাডমিন: ইউজারের পাসওয়ার্ড বদলানো (অ্যাডমিন প্যানেল থেকে)
app.post("/api/admin/users/:phone/password", requireAdmin, async (req, res) => {
  try {
    const phone = String(req.params.phone || "").trim();
    const password = String(req.body.password || "").trim();
    if (!validPhone(phone)) return res.status(400).json({ message: "সঠিক মোবাইল নম্বর দিন" });
    if (password.length < 4) return res.status(400).json({ message: "পাসওয়ার্ড কমপক্ষে ৪ অক্ষর হতে হবে" });
    const ref = db.ref(`users/${phone}`);
    const snap = await ref.once("value");
    if (!snap.exists()) return res.status(404).json({ message: "ইউজার পাওয়া যায়নি" });
    await ref.update({ password });
    return res.json({ ok: true });
  } catch (e) {
    console.error("admin password error:", e);
    return res.status(500).json({ message: "পাসওয়ার্ড বদলানো যায়নি" });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true, service: "SPL User Backend", paymentGateway: "NEKpay", adapterReady: false }));
app.listen(PORT, () => {
  console.log(`SPL User Backend listening on ${PORT}`);
  processAllDueEarnings();
  setInterval(processAllDueEarnings, 60 * 1000);
});
