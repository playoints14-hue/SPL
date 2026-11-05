
const express = require("express");
const admin = require("firebase-admin");
const crypto = require("crypto");
const path = require("path");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname)));

const MCH_ID = process.env.WPAY_MCH_ID || "5375";
const API_SECRET = process.env.WPAY_API_SECRET;
const BASE_URL = (process.env.WPAY_BASE_URL || "https://api.wpay.life")
  .trim()
  .replace(/\/+$/, "");
const PUBLIC_URL = (process.env.PUBLIC_URL || "")
  .trim()
  .replace(/\/+$/, "");

if (!API_SECRET) {
  console.warn("Missing WPAY_API_SECRET");
}

// Firebase setup
if (!admin.apps.length) {
  const privateKey = [
    process.env.FIREBASE_PRIVATE_KEY_1 || "",
    process.env.FIREBASE_PRIVATE_KEY_2 || "",
    process.env.FIREBASE_PRIVATE_KEY_3 || ""
  ].join("").replace(/\\n/g, "\n");

  const serviceAccount = {
    project_id: process.env.FIREBASE_PROJECT_ID,
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    private_key: privateKey
  };

  if (
    !serviceAccount.project_id ||
    !serviceAccount.client_email ||
    !serviceAccount.private_key ||
    !process.env.FIREBASE_DATABASE_URL
  ) {
    throw new Error("Missing Firebase environment variables");
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
}

const db = admin.database();

function sign(params) {
  const text = Object.keys(params)
    .filter(
      k =>
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

  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function methodCode(method) {
  return {
    bkash: "BKASH",
    nagad: "NAGAD",
    rocket: "ROCKET"
  }[String(method).toLowerCase()];
}

// Create WPAY payment
app.post("/api/wpay/collect", async (req, res) => {
  try {
    if (!API_SECRET) {
      return res.status(503).json({
        message: "WPAY not configured"
      });
    }

    const { userPhone, amount, method } = req.body || {};
    const money = Number(amount);
    const pay_type = methodCode(method);

    if (!userPhone || !Number.isFinite(money) || money < 500 || !pay_type) {
      return res.status(400).json({
        message: "Invalid deposit request"
      });
    }

    const userSnap = await db
      .ref("users")
      .child(String(userPhone))
      .once("value");

    if (!userSnap.exists() || userSnap.val().isBanned) {
      return res.status(403).json({
        message: "User not allowed"
      });
    }

    const out_trade_no =
      `SPL${Date.now()}${crypto.randomBytes(3).toString("hex")}`;

    const order = {
      mchId: MCH_ID,
      currency: "BDT",
      out_trade_no,
      pay_type,
      money: money.toFixed(2),
      attach: String(userPhone),
      notify_url: `${PUBLIC_URL}/api/wpay/notify`,
      returnUrl: `${PUBLIC_URL}/?payment=return`
    };

    order.sign = sign(order);

    await db.ref("wpay_orders").child(out_trade_no).set({
      userPhone: String(userPhone),
      amount: money,
      method: String(method).toLowerCase(),
      status: "pending",
      createdAt: admin.database.ServerValue.TIMESTAMP
    });

    const response = await fetch(`${BASE_URL}/v1/Collect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(order)
    });

    const data = await response.json();

    if (!response.ok || Number(data.code) !== 0 || !data.data?.url) {
      await db.ref("wpay_orders").child(out_trade_no).update({
        status: "gateway_error",
        gatewayResponse: data
      });

      return res.status(502).json({
        message: data.msg || data.message || "WPAY request failed"
      });
    }

    await db.ref("wpay_orders").child(out_trade_no).update({
      transactionId: data.data.transaction_Id || null
    });

    return res.json({
      paymentUrl: data.data.url,
      orderId: out_trade_no
    });
  } catch (e) {
    console.error("WPAY collect error", e);

    return res.status(500).json({
      message: "Could not create payment"
    });
  }
});

// WPAY payment notification
app.post("/api/wpay/notify", async (req, res) => {
  try {
    const payload = req.body || {};

    if (
      !API_SECRET ||
      !payload.sign ||
      !safeEqual(sign(payload), payload.sign)
    ) {
      return res.status(400).send("fail");
    }

    const orderNo = payload.out_trade_no;

    const orderRef = db
      .ref("wpay_orders")
      .child(String(orderNo));

    const snap = await orderRef.once("value");

    if (!snap.exists()) {
      return res.status(404).send("fail");
    }

    const order = snap.val();

    const status = String(
      payload.status ??
      payload.trade_status ??
      payload.pay_status ??
      ""
    );

    const paidAmount = Number(
      payload.money ??
      payload.amount ??
      payload.total_fee
    );

    if (status !== "1" || paidAmount !== Number(order.amount)) {
      return res.status(400).send("fail");
    }

    if (order.status === "success") {
      return res.status(200).send("success");
    }

    const userRef = db
      .ref("users")
      .child(order.userPhone);

    await userRef.transaction(user => {
      if (!user) return;

      user.deposits = user.deposits || {};

      if (
        Object.values(user.deposits).some(
          d => d.out_trade_no === orderNo
        )
      ) {
        return user;
      }

      user.balance =
        Number(user.balance || 0) + Number(order.amount);

      user.deposits[orderNo] = {
        amount: Number(order.amount),
        method: order.method,
        trxId:
          payload.transaction_Id ||
          payload.trade_no ||
          orderNo,
        out_trade_no: orderNo,
        status: "সফল",
        date: new Date().toLocaleDateString("bn-BD"),
        confirmedAt: Date.now()
      };

      return user;
    });

    await orderRef.update({
      status: "success",
      callback: payload,
      paidAt: admin.database.ServerValue.TIMESTAMP
    });

    return res.status(200).send("success");
  } catch (e) {
    console.error("WPAY notify error", e);

    return res.status(500).send("fail");
  }
});

app.get("/health", (_, res) => {
  res.json({ ok: true });
});

const port = process.env.PORT || 8080;

app.listen(port, "0.0.0.0", () => {
  console.log(`SPL backend listening on ${port}`);
});
