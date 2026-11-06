const express = require("express");
const admin = require("firebase-admin");
const crypto = require("crypto");
const path = require("path");

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "100kb" }));
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;
const MCH_ID = String(process.env.WPAY_MCH_ID || "5375");
const API_SECRET = process.env.WPAY_API_SECRET;
const BASE_URL = (process.env.WPAY_BASE_URL || "https://api.wpay.life").replace(/\/$/, "");
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");

if (!API_SECRET) console.warn("WARNING: WPAY_API_SECRET is missing");
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

app.post("/api/wpay/collect", async (req, res) => {
  try {
    if (!API_SECRET || !PUBLIC_URL) return res.status(503).json({ message: "WPAY is not configured" });
    const userPhone = String(req.body.userPhone || "").trim();
    const amount = Number(req.body.amount);
    const method = String(req.body.method || "").toLowerCase();
    const pay_type = methodCode(method);
    if (!validPhone(userPhone)) return res.status(400).json({ message: "Invalid user phone" });
    if (!Number.isFinite(amount) || amount < 500 || amount > 50000) return res.status(400).json({ message: "Invalid deposit amount" });
    if (!pay_type) return res.status(400).json({ message: "Invalid payment method" });

    const userRef = db.ref("users").child(userPhone);
    const userSnap = await userRef.once("value");
    if (!userSnap.exists() || userSnap.val().isBanned) return res.status(403).json({ message: "User not allowed" });

    const orderId = `SPL${Date.now()}${crypto.randomBytes(4).toString("hex")}`;
    const order = {
      mchId: MCH_ID, currency: "BDT", out_trade_no: orderId, pay_type,
      money: amount.toFixed(2), attach: userPhone,
      notify_url: `${PUBLIC_URL}/api/wpay/notify`,
      returnUrl: `${PUBLIC_URL}/?payment=return`
    };
    order.sign = sign(order);

    const orderRef = db.ref("wpay_orders").child(orderId);
    await orderRef.set({ orderId, userPhone, amount, method, status: "pending", createdAt: admin.database.ServerValue.TIMESTAMP });
    await userRef.child("deposits").child(orderId).set({
      amount, method, status: "অপেক্ষমাণ", out_trade_no: orderId, trxId: orderId,
      date: new Date().toLocaleDateString("bn-BD"), createdAt: Date.now()
    });

    const response = await fetch(`${BASE_URL}/v1/Collect`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(order)
    });
    const data = await response.json();
    if (!response.ok || Number(data.code) !== 0 || !data.data?.url) {
      await orderRef.update({ status: "gateway_error", gatewayResponse: data });
      await userRef.child("deposits").child(orderId).update({ status: "gateway_error" });
      return res.status(502).json({ message: data.msg || data.message || "WPAY request failed" });
    }
    await orderRef.update({ gatewayTransactionId: data.data.transaction_Id || null });
    return res.json({ paymentUrl: data.data.url, orderId });
  } catch (error) {
    console.error("WPAY collect error:", error);
    return res.status(500).json({ message: "Could not create payment" });
  }
});

app.post("/api/wpay/notify", async (req, res) => {
  try {
    const p = req.body || {};
    if (!API_SECRET || !p.sign || !safeEqual(sign(p), p.sign)) return res.status(400).send("SIGN_ERROR");
    if (String(p.mchId || p.mch_id || "") !== MCH_ID) return res.status(400).send("MERCHANT_ERROR");

    const orderId = String(p.out_trade_no || "").trim();
    const providerTx = String(p.transaction_Id || p.transaction_id || p.trxId || p.trade_no || "").trim();
    const status = String(p.status ?? p.trade_status ?? p.pay_status ?? p.status_code ?? "").toLowerCase();
    if (!orderId || !providerTx) return res.status(400).send("MISSING_TRANSACTION");
    if (status !== "1" && status !== "success") return res.status(200).send("SUCCESS");

    const orderRef = db.ref("wpay_orders").child(orderId);
    const orderSnap = await orderRef.once("value");
    if (!orderSnap.exists()) return res.status(404).send("ORDER_NOT_FOUND");
    const order = orderSnap.val();
    if (order.status === "success") return res.status(200).send("SUCCESS");
    if (!validPhone(order.userPhone)) return res.status(400).send("INVALID_USER");

    const paidAmount = Number(p.money ?? p.amount ?? p.total_fee);
    if (!Number.isFinite(paidAmount) || Math.abs(paidAmount - Number(order.amount)) > 0.001) return res.status(400).send("AMOUNT_ERROR");

    const trxKey = crypto.createHash("sha256").update(providerTx.trim().toUpperCase()).digest("hex");
    const claimRef = db.ref("used_transaction_ids").child(trxKey);
    const claim = await claimRef.transaction(current => {
      if (current === null) return { orderId, providerTransactionId: providerTx, claimedAt: Date.now() };
      if (current.orderId === orderId) return current;
      return;
    });
    if (!claim.committed) return res.status(409).send("TRANSACTION_ALREADY_USED");

    const userRef = db.ref("users").child(order.userPhone);
    const credit = await userRef.transaction(user => {
      if (!user) return;
      user.balance = Number(user.balance || 0);
      user.deposits = user.deposits || {};
      const old = user.deposits[orderId] || {};
      // Transactional idempotency: only this order can add its amount once.
      if (old.status !== "সফল" && old.status !== "success") {
        user.balance += Number(order.amount);
        user.deposits[orderId] = {
          ...old, amount: Number(order.amount), method: order.method,
          trxId: providerTx, providerTransactionId: providerTx, out_trade_no: orderId,
          status: "সফল", date: new Date().toLocaleDateString("bn-BD"), confirmedAt: Date.now()
        };
      }
      return user;
    });
    if (!credit.committed) return res.status(404).send("USER_OR_CREDIT_ERROR");

    await orderRef.update({ status: "success", providerTransactionId: providerTx, callback: p, paidAt: admin.database.ServerValue.TIMESTAMP });
    await creditReferralCommissions(order.userPhone, Number(order.amount), orderId);
    await creditDueEarningsForUser(order.userPhone);
    return res.status(200).send("SUCCESS");
  } catch (error) {
    console.error("WPAY notify error:", error);
    return res.status(500).send("ERROR");
  }
});

app.get("/health", (_req, res) => res.json({ ok: true, service: "SPL User Backend" }));
app.listen(PORT, () => {
  console.log(`SPL User Backend listening on ${PORT}`);
  processAllDueEarnings();
  setInterval(processAllDueEarnings, 60 * 1000);
});
