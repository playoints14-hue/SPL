const express = require("express");
const admin = require("firebase-admin");
const crypto = require("crypto");
const path = require("path");

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "100kb" }));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

const PORT = process.env.PORT || 3000;
const MCH_ID = String(process.env.NEKPAY_MCH_ID || "808258224");
const API_SECRET = process.env.NEKPAY_PAYMENT_KEY;
const BASE_URL = (process.env.NEKPAY_API_URL || "").replace(/\/$/, "");
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";

if (!API_SECRET) console.warn("WARNING: NEKPAY_PAYMENT_KEY is missing");
if (!PUBLIC_URL) console.warn("WARNING: PUBLIC_URL is missing");
if (!ADMIN_SECRET) console.warn("WARNING: ADMIN_SECRET is missing, admin actions disabled");

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

function validPhone(phone) { return /^01[3-9]\d{8}$/.test(String(phone || "")); }

// ---------------- Helpers ----------------
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
          if (!u) return u;
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
        user.earningLogs[`${id}_${at}`] = {
          investmentId: id,
          packageId: inv.packageId || null,
          title: inv.title || "প্ল্যান",
          amount: daily,
          paidAt: at,
          source: "auto_24h"
        };
      }
    }
    return user;
  });
  return !!result.committed;
}

async function processAllDueEarnings() {
  try {
    const snap = await db.ref("users").once("value");
    const users = snap.val() || {};
    for (const phone of Object.keys(users)) {
      try { await creditDueEarningsForUser(phone); } catch (e) { console.error("earning worker", phone, e); }
    }
  } catch (e) {
    console.error("earning worker failed:", e);
  }
}

// ---------------- Register ----------------
app.post("/api/register", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const phone = String(req.body.phone || "").trim();
    const password = String(req.body.password || "").trim();
    const invitedByCode = String(req.body.invitedByCode || "").trim() || null;
    const deviceId = String(req.body.deviceId || "").trim();
    if (!name || !validPhone(phone) || password.length < 4) {
      return res.status(400).json({ message: "সঠিক নাম, মোবাইল নম্বর ও পাসওয়ার্ড দিন" });
    }
    const userRef = db.ref(`users/${phone}`);
    const exists = await userRef.once("value");
    if (exists.exists()) return res.status(409).json({ message: "এই মোবাইল নম্বর দিয়ে ইতিমধ্যে অ্যাকাউন্ট খোলা হয়েছে!" });

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
    return res.status(500).json({ message: "নিবন্ধন করা যায়নি" });
  }
});

// ---------------- NEKpay deposit (collect) ----------------
app.set("trust proxy", true);
const PAY_TYPES = {
  bkash: process.env.NEKPAY_PAYTYPE_BKASH || "2222",
  nagad: process.env.NEKPAY_PAYTYPE_NAGAD || "2221"
};
const CALLBACK_IP = String(process.env.NEKPAY_CALLBACK_IP || "").trim();
const COLLECT_URL = (process.env.NEKPAY_API_URL || "https://api.nekpayment.com/pay/web").trim();

// NEKpay সাইন: প্যারামিটার ASCII অনুসারে সাজিয়ে, sign/sign_type ও খালি মান বাদ দিয়ে,
// শেষে &key=PAYMENT_KEY যোগ করে MD5 (lowercase)। NEKpay ডকের সাথে না মিললে এই ফাংশন বদলান।
function nekSign(params) {
  const str = Object.keys(params)
    .filter(k => k !== "sign" && k !== "sign_type" && k !== "signType" && params[k] !== undefined && params[k] !== null && String(params[k]) !== "")
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join("&") + `&key=${API_SECRET}`;
  return crypto.createHash("md5").update(str, "utf8").digest("hex").toLowerCase();
}

function safeEq(a, b) {
  const x = Buffer.from(String(a).toUpperCase()), y = Buffer.from(String(b).toUpperCase());
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function nowBD() {
  const d = new Date(Date.now() + 6 * 3600 * 1000);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

app.post("/api/nekpay/collect", async (req, res) => {
  try {
    const userPhone = String(req.body.userPhone || "").trim();
    const amount = Number(req.body.amount);
    const payType = PAY_TYPES[String(req.body.method || "").toLowerCase()];
    if (!validPhone(userPhone)) return res.status(400).json({ message: "সঠিক মোবাইল নম্বর পাওয়া যায়নি" });
    if (!Number.isFinite(amount) || amount < 100 || amount > 50000) {
      return res.status(400).json({ message: "পেমেন্ট পরিমাণ ১০০ থেকে ৫০,০০০ টাকার মধ্যে দিন" });
    }
    if (!payType) return res.status(400).json({ message: "সমর্থিত পেমেন্ট মেথড নির্বাচন করুন" });
    if (!API_SECRET || !MCH_ID || !PUBLIC_URL) return res.status(503).json({ message: "NEKpay কনফিগারেশন অসম্পূর্ণ।" });

    const userSnap = await db.ref(`users/${userPhone}`).once("value");
    if (!userSnap.exists()) return res.status(404).json({ message: "ইউজার অ্যাকাউন্ট পাওয়া যায়নি" });

    const orderId = `SPL${Date.now()}${Math.floor(1000 + Math.random() * 9000)}`;
    const tradeAmount = amount.toFixed(2);
    const payerName = String(userSnap.val().name || "").replace(/[^A-Za-z ]/g, "").trim() || "Customer";
    const params = {
      version: "1.0", mch_id: MCH_ID,
      notify_url: `${PUBLIC_URL}/api/nekpay/notify`,
      page_url: `${PUBLIC_URL}/`,
      mch_order_no: orderId, pay_type: payType, trade_amount: tradeAmount,
      order_date: nowBD(), goods_name: "SPL Recharge", payer_name: payerName
    };
    params.sign = nekSign(params);
    params.sign_type = "MD5";

    await db.ref(`nekpay_orders/${orderId}`).set({
      userPhone, amount: Number(tradeAmount), method: req.body.method, payType,
      status: "pending", createdAt: Date.now()
    });
    await db.ref(`users/${userPhone}/deposits/${orderId}`).set({
      amount: Number(tradeAmount), method: String(req.body.method || ""), status: "অপেক্ষমাণ",
      out_trade_no: orderId, trxId: orderId, createdAt: Date.now(),
      date: new Date(Date.now() + 6 * 3600 * 1000).toISOString().slice(0, 10)
    });

    const r = await fetch(COLLECT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString()
    });
    const text = await r.text();
    let data = {};
    try { data = JSON.parse(text); } catch (_) {}
    console.log("NEKpay collect response:", orderId, "payType=" + payType, text.slice(0, 500));

    const paymentUrl = data.payInfo || data.pay_info || data.payUrl || data.pay_url || data.url;
    const ok = String(data.respCode || data.resp_code || "").toUpperCase() === "SUCCESS" || !!paymentUrl;
    if (!ok || !paymentUrl) {
      await db.ref(`nekpay_orders/${orderId}`).update({ status: "failed", reason: text.slice(0, 300) });
      await db.ref(`users/${userPhone}/deposits/${orderId}`).update({ status: "ব্যর্থ" });
      return res.status(502).json({
        message: "NEKpay উত্তর: " + (data.tradeMsg || data.errorMsg || data.error_msg || data.msg || text.slice(0, 160) || ("HTTP " + r.status))
      });
    }
    return res.json({ ok: true, orderId, paymentUrl });
  } catch (e) {
    console.error("NEKpay collect error:", e);
    return res.status(500).json({ message: "সার্ভার ত্রুটি: " + String(e && e.message || e).slice(0, 160) });
  }
});

// ---------------- NEKpay notify (ডিপোজিট অটো-ক্রেডিট) ----------------
app.all("/api/nekpay/notify", async (req, res) => {
  try {
    const p = { ...req.query, ...req.body };
    console.log("NEKpay notify:", JSON.stringify(p).slice(0, 800));

    // IP চেক (NEKPAY_CALLBACK_IP সেট থাকলে)
    const remoteIp = String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
    if (CALLBACK_IP && remoteIp !== CALLBACK_IP) {
      console.warn("NEKpay notify from unexpected IP:", remoteIp, "expected:", CALLBACK_IP);
      return res.send("fail");
    }

    // সিগনেচার যাচাই
    const given = String(p.sign || "");
    if (!given || !safeEq(given, nekSign(p))) {
      console.warn("NEKpay notify: bad signature. fields:", Object.keys(p).join(","));
      return res.send("fail");
    }

    const orderId = String(p.mch_order_no || p.mchOrderNo || p.out_trade_no || "");
    if (!orderId) { console.warn("NEKpay notify: order id field not found. fields:", Object.keys(p).join(",")); return res.send("fail"); }
    const orderRef = db.ref(`nekpay_orders/${orderId}`);
    const order = (await orderRef.once("value")).val();
    if (!order) { console.warn("NEKpay notify: order not in DB:", orderId); return res.send("fail"); }

    // সফল স্ট্যাটাস (NEKpay ডকের সাথে মিলিয়ে নিন; লগের নোটিফাই লাইন দেখে ফিল্ডের নাম ঠিক করুন)
    const status = String(p.trade_status ?? p.tradeResult ?? p.status ?? "").toUpperCase();
    const isPaid = ["SUCCESS", "PAID", "1"].includes(status);
    if (!isPaid) {
      console.warn("NEKpay notify: not paid, status =", status);
      await orderRef.update({ gatewayStatus: status, updatedAt: Date.now() });
      return res.send("success");
    }

    // পরিমাণ মিলছে কিনা
    const paidAmount = Number(p.oriAmount ?? p.trade_amount ?? p.amount);
    if (!Number.isFinite(paidAmount) || Math.abs(paidAmount - Number(order.amount)) > 0.01) {
      await orderRef.update({ status: "amount_mismatch", paidAmount, updatedAt: Date.now() });
      return res.send("fail");
    }

    // একবারই ক্রেডিট: pending থেকে credited
    const claim = await orderRef.child("status").transaction(cur =>
      cur === "pending" ? "credited" : undefined
    );
    if (!claim.committed) return res.send("success");

    const userPhone = order.userPhone;
    await db.ref(`users/${userPhone}/balance`).transaction(b =>
      Number((Number(b || 0) + Number(order.amount)).toFixed(2))
    );
    await db.ref(`users/${userPhone}/deposits/${orderId}`).update({
      status: "সফল",
      confirmedAt: Date.now(),
      trxId: String(p.orderNo || p.trade_no || p.transaction_id || orderId)
    });
    await orderRef.update({ confirmedAt: Date.now(), gatewayStatus: status });

    await creditReferralCommissions(userPhone, order.amount, orderId);
    return res.send("success");
  } catch (e) {
    console.error("NEKpay notify error:", e);
    return res.send("fail");
  }
});

// ---------------- Withdraw (ব্যালেন্স সার্ভারে কাটা) ----------------
app.post("/api/withdraw", async (req, res) => {
  let deducted = 0, userPhone = "";
  try {
    userPhone = String(req.body.userPhone || "").trim();
    const password = String(req.body.password || "");
    const amount = Number(req.body.amount);
    if (!validPhone(userPhone)) return res.status(400).json({ message: "সঠিক মোবাইল নম্বর নেই" });

    const settings = await getSiteSettings();
    const min = Math.max(1, Number(settings.withdrawal_min_amount ?? settings.minimum_withdrawal ?? 150));
    const max = Math.max(min, Number(settings.withdrawal_max_amount ?? 500000));
    const feePct = Math.min(100, Math.max(0, Number(settings.withdrawal_fee_percent ?? 10)));
    if (!Number.isFinite(amount) || amount < min || amount > max) {
      return res.status(400).json({ message: `উত্তোলনের পরিমাণ ${min} থেকে ${max} টাকার মধ্যে দিন` });
    }

    const user = (await db.ref(`users/${userPhone}`).once("value")).val();
    if (!user) return res.status(404).json({ message: "ইউজার পাওয়া যায়নি" });
    if (user.password !== password) return res.status(401).json({ message: "লগইন পাসওয়ার্ড সঠিক নয়!" });
    if (user.isBanned || user.withdrawalDisabled) return res.status(403).json({ message: "এই অ্যাকাউন্টে উত্তোলন বন্ধ" });
    if (!user.investments || Object.keys(user.investments).length === 0) {
      return res.status(403).json({ message: "উত্তোলনের আগে কমপক্ষে একটি প্ল্যান কিনুন" });
    }
    if (!user.withdrawAccount || !user.withdrawAccount.number) {
      return res.status(400).json({ message: "আগে পেমেন্ট অ্যাকাউন্ট সেটআপ করুন" });
    }

    const fee = Number((amount * feePct / 100).toFixed(2));
    const net = Number((amount - fee).toFixed(2));

    // ব্যালেন্স থেকে কাটা; পর্যাপ্ত না থাকলে কাটবে না
    const tx = await db.ref(`users/${userPhone}/balance`).transaction(b => {
      const cur = Number(b || 0);
      if (cur < amount) return; // abort
      return Number((cur - amount).toFixed(2));
    });
    if (!tx.committed) return res.status(400).json({ message: "আপনার ওয়ালেটে পর্যাপ্ত ব্যালেন্স নেই!" });
    deducted = amount;

    const key = db.ref("withdrawal_requests").push().key;
    const record = {
      id: key, userPhone, userName: user.name || "",
      amount, fee, netAmount: net,
      method: user.withdrawAccount.method || "bkash",
      accountName: user.withdrawAccount.name || "",
      accountNumber: user.withdrawAccount.number,
      status: "পেন্ডিং",
      createdAt: Date.now(),
      date: new Date(Date.now() + 6 * 3600 * 1000).toISOString().slice(0, 10)
    };
    await db.ref().update({
      [`withdrawal_requests/${key}`]: record,
      [`users/${userPhone}/withdrawals/${key}`]: record
    });
    return res.json({ ok: true, id: key, newBalance: tx.snapshot.val() });
  } catch (e) {
    // রেকর্ড লেখা ব্যর্থ হলে কাটা টাকা ফেরত
    if (deducted && userPhone) {
      await db.ref(`users/${userPhone}/balance`)
        .transaction(b => Number((Number(b || 0) + deducted).toFixed(2)))
        .catch(() => {});
    }
    console.error("withdraw error:", e);
    return res.status(500).json({ message: "উত্তোলন জমা হয়নি, আবার চেষ্টা করুন" });
  }
});

// ---------------- Admin: উত্তোলন Approve / Reject ----------------
function isAdmin(req) {
  return !!ADMIN_SECRET && safeEq(String(req.headers["x-admin-secret"] || ""), ADMIN_SECRET);
}

app.post("/api/admin/withdraw/decide", async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ message: "অনুমতি নেই" });
  const id = String(req.body.id || "");
  const decision = String(req.body.decision || "");
  const note = String(req.body.note || "");
  if (!id || !["approve", "reject"].includes(decision)) {
    return res.status(400).json({ message: "id ও decision (approve/reject) দিন" });
  }
  try {
    const reqRef = db.ref(`withdrawal_requests/${id}`);
    const rec = (await reqRef.once("value")).val();
    if (!rec) return res.status(404).json({ message: "রিকোয়েস্ট পাওয়া যায়নি" });

    const newStatus = decision === "approve" ? "সফল" : "বাতিল";
    // ডাবল প্রসেস ঠেকাতে: শুধু পেন্ডিং থেকে বদলাবে
    const claim = await reqRef.child("status").transaction(cur =>
      cur === "পেন্ডিং" ? newStatus : undefined
    );
    if (!claim.committed) return res.status(400).json({ message: "ইতিমধ্যে প্রসেস হয়েছে" });

    await db.ref().update({
      [`withdrawal_requests/${id}/processedAt`]: Date.now(),
      [`withdrawal_requests/${id}/note`]: note,
      [`users/${rec.userPhone}/withdrawals/${id}/status`]: newStatus,
      [`users/${rec.userPhone}/withdrawals/${id}/processedAt`]: Date.now()
    });

    // Reject হলে কাটা টাকা ফেরত
    if (decision === "reject") {
      await db.ref(`users/${rec.userPhone}/balance`).transaction(b =>
        Number((Number(b || 0) + Number(rec.amount)).toFixed(2))
      );
    }
    return res.json({ ok: true, status: newStatus });
  } catch (e) {
    console.error("decide error:", e);
    return res.status(500).json({ message: "সমস্যা হয়েছে" });
  }
});

app.get("/health", (_req, res) => res.json({
  ok: true, service: "SPL User Backend", paymentGateway: "NEKpay", adapterReady: !!API_SECRET
}));

app.listen(PORT, () => {
  console.log(`SPL User Backend listening on ${PORT}`);
  processAllDueEarnings();
  setInterval(processAllDueEarnings, 60 * 1000);
});
