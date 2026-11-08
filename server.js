const express = require("express");
const admin = require("firebase-admin");
const crypto = require("crypto");
const path = require("path");

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "100kb" }));
app.use(express.static(path.join(__dirname)));

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

function sign(params) {
  const text = Object.keys(params)
    .filter(k => k !== "sign" && params[k] !== undefined && params[k] !== null && params[k] !== "")
    .sort().map(k => `${k}=${params[k]}`).join("&") + `&key=${API_SECRET}`;
  return crypto.createHash("md5").update(text, "utf8").digest("hex").toLowerCase();
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a || "").toLowerCase());
  const y = Buffer.from(String(b || "").toLowerCase());
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function methodCode(method) {
  return ({ bkash: "BKASH", nagad: "NAGAD", rocket: "ROCKET" })[String(method || "").toLowerCase()];
}
function validPhone(phone) { return /^01[3-9]\d{8}$/.test(String(phone || "")); }


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
    ? settings.referral_commission_rates : [10, 2, 1])
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
    return changed ? user : user;
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
    const referralCode = `SPL${phone.slice(-4)}${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
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


// NEKpay integration scaffold.
// The merchant's exact Collect endpoint, field names, response schema and callback
// verification contract have not been supplied. Do not guess these values.
// Fill the marked adapter only from NEKpay's official API specification.
app.post("/api/nekpay/collect", async (req, res) => {
  return res.status(503).json({
    message: "NEKpay adapter is not configured yet. Add the official Collect API mapping before accepting deposits."
  });
});

app.post("/api/nekpay/notify", async (req, res) => {
  // Intentionally fail closed: never credit a wallet without official callback
  // signature, merchant/order/amount/status validation and idempotency checks.
  return res.status(501).send("NEKPAY_CALLBACK_NOT_CONFIGURED");
});

app.get("/health", (_req, res) => res.json({ ok: true, service: "SPL User Backend" }));
app.listen(PORT, () => {
  console.log(`SPL User Backend listening on ${PORT}`);
  processAllDueEarnings();
  setInterval(processAllDueEarnings, 60 * 1000);
});
