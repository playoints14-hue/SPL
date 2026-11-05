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

if (!API_SECRET) {
  console.warn("WARNING: WPAY_API_SECRET is missing");
}

if (!PUBLIC_URL) {
  console.warn("WARNING: PUBLIC_URL is missing");
}

if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is required");
}

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  );

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
}

const db = admin.database();

function sign(params) {
  const text = Object.keys(params)
    .filter(k =>
      k !== "sign" &&
      params[k] !== undefined &&
      params[k] !== null &&
      params[k] !== ""
    )
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join("&") + `&key=${API_SECRET}`;

  return crypto
    .createHash("md5")
    .update(text, "utf8")
    .digest("hex")
    .toLowerCase();
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || "").toLowerCase());
  const y = Buffer.from(String(b || "").toLowerCase());

  return x.length === y.length &&
    crypto.timingSafeEqual(x, y);
}

function methodCode(method) {
  return {
    bkash: "BKASH",
    nagad: "NAGAD",
    rocket: "ROCKET"
  }[String(method || "").toLowerCase()];
}

function validPhone(phone) {
  return /^01[3-9]\d{8}$/.test(String(phone));
}

/* ==============================
   CREATE DEPOSIT
============================== */

app.post("/api/wpay/collect", async (req, res) => {
  try {
    if (!API_SECRET || !PUBLIC_URL) {
      return res.status(503).json({
        message: "WPAY is not configured"
      });
    }

    const userPhone = String(req.body.userPhone || "").trim();
    const amount = Number(req.body.amount);
    const method = String(req.body.method || "").toLowerCase();
    const pay_type = methodCode(method);

    if (!validPhone(userPhone)) {
      return res.status(400).json({
        message: "Invalid user phone"
      });
    }

    if (
      !Number.isFinite(amount) ||
      amount < 500 ||
      amount > 50000
    ) {
      return res.status(400).json({
        message: "Invalid deposit amount"
      });
    }

    if (!pay_type) {
      return res.status(400).json({
        message: "Invalid payment method"
      });
    }

    const userRef = db.ref("users").child(userPhone);
    const userSnap = await userRef.once("value");

    if (!userSnap.exists() || userSnap.val().isBanned) {
      return res.status(403).json({
        message: "User not allowed"
      });
    }

    const orderId =
      `SPL${Date.now()}${crypto.randomBytes(4).toString("hex")}`;

    const order = {
      mchId: MCH_ID,
      currency: "BDT",
      out_trade_no: orderId,
      pay_type,
      money: amount.toFixed(2),
      attach: userPhone,
      notify_url: `${PUBLIC_URL}/api/wpay/notify`,
      returnUrl: `${PUBLIC_URL}/?payment=return`
    };

    order.sign = sign(order);

    const orderRef = db.ref("wpay_orders").child(orderId);

    await orderRef.set({
      orderId,
      userPhone,
      amount,
      method,
      status: "pending",
      createdAt: admin.database.ServerValue.TIMESTAMP
    });

    await userRef.child("deposits").child(orderId).set({
      amount,
      method,
      status: "অপেক্ষমাণ",
      out_trade_no: orderId,
      trxId: orderId,
      date: new Date().toLocaleDateString("bn-BD"),
      createdAt: Date.now()
    });

    const response = await fetch(`${BASE_URL}/v1/Collect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(order)
    });

    const data = await response.json();

    if (
      !response.ok ||
      Number(data.code) !== 0 ||
      !data.data?.url
    ) {
      await orderRef.update({
        status: "gateway_error",
        gatewayResponse: data
      });

      return res.status(502).json({
        message: data.msg || data.message || "WPAY request failed"
      });
    }

    await orderRef.update({
      gatewayTransactionId: data.data.transaction_Id || null
    });

    return res.json({
      paymentUrl: data.data.url,
      orderId
    });

  } catch (error) {
    console.error("WPAY collect error:", error);

    return res.status(500).json({
      message: "Could not create payment"
    });
  }
});


/* ==============================
   WPAY PAYMENT CALLBACK
============================== */

app.post("/api/wpay/notify", async (req, res) => {
  try {
    const payload = req.body || {};

    if (!API_SECRET || !payload.sign) {
      return res.status(400).send("SIGN_ERROR");
    }

    if (!safeEqual(sign(payload), payload.sign)) {
      return res.status(400).send("SIGN_ERROR");
    }

    const merchantId = String(
      payload.mchId || payload.mch_id || ""
    );

    if (merchantId !== MCH_ID) {
      return res.status(400).send("MERCHANT_ERROR");
    }

    const orderId = String(payload.out_trade_no || "").trim();

    const providerTx = String(
      payload.transaction_Id ||
      payload.transaction_id ||
      payload.trxId ||
      payload.trade_no ||
      ""
    ).trim();

    const status = String(
      payload.status ??
      payload.trade_status ??
      payload.pay_status ??
      payload.status_code ??
      ""
    ).toLowerCase();

    if (!orderId || !providerTx) {
      return res.status(400).send("MISSING_TRANSACTION");
    }

    // Only confirmed successful payments are credited.
    if (status !== "1" && status !== "success") {
      return res.status(200).send("SUCCESS");
    }

    const orderRef = db.ref("wpay_orders").child(orderId);
    const orderSnap = await orderRef.once("value");

    if (!orderSnap.exists()) {
      return res.status(404).send("ORDER_NOT_FOUND");
    }

    const order = orderSnap.val();

    if (order.status === "success") {
      return res.status(200).send("SUCCESS");
    }

    if (!validPhone(order.userPhone)) {
      return res.status(400).send("INVALID_USER");
    }

    const paidAmount = Number(
      payload.money ??
      payload.amount ??
      payload.total_fee
    );

    if (
      !Number.isFinite(paidAmount) ||
      Math.abs(paidAmount - Number(order.amount)) > 0.001
    ) {
      return res.status(400).send("AMOUNT_ERROR");
    }

    const trxKey = crypto
      .createHash("sha256")
      .update(providerTx.trim().toUpperCase())
      .digest("hex");

    const claimRef = db.ref("used_transaction_ids").child(trxKey);

    // A provider transaction can belong to only one order.
    const claim = await claimRef.transaction(current => {
      if (current === null) {
        return {
          orderId,
          providerTransactionId: providerTx,
          claimedAt: Date.now()
        };
      }

      if (current.orderId === orderId) {
        return current;
      }

      return;
    });

    if (!claim.committed) {
      return res.status(409).send("TRANSACTION_ALREADY_USED");
    }

    const userRef = db.ref("users").child(order.userPhone);

    // Idempotent credit: the same order cannot credit twice.
    const credit = await userRef.transaction(user => {
      if (!user) return;

      user.balance = Number(user.balance || 0);
      user.deposits = user.deposits || {};

      const existing = user.deposits[orderId];

      if (existing && existing.out_trade_no !== orderId) {
        return;
      }

      if (!existing || existing.status !== "সফল") {
        user.balance += Number(order.amount);

        user.deposits[orderId] = {
          ...(existing || {}),
          amount: Number(order.amount),
          method: order.method,
          trxId: providerTx,
          providerTransactionId: providerTx,
          out_trade_no: orderId,
          status: "সফল",
          date: new Date().toLocaleDateString("bn-BD"),
          confirmedAt: Date.now()
        };
      }

      return user;
    });

    if (!credit.committed) {
      return res.status(500).send("CREDIT_FAILED");
    }

    await orderRef.update({
      status: "success",
      providerTransactionId: providerTx,
      callback: payload,
      paidAt: admin.database.ServerValue.TIMESTAMP
    });

    return res.status(200).send("SUCCESS");

  } catch (error) {
    console.error("WPAY notify error:", error);

    return res.status(500).send("ERROR");
  }
});


/* ==============================
   HEALTH CHECK
============================== */

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "SPL User Backend"
  });
});


app.listen(PORT, () => {
  console.log(`SPL User Backend listening on ${PORT}`);
});
