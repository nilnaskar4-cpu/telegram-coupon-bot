require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const QRCode = require("qrcode");
const { v4: uuidv4 } = require("uuid");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const ADMIN_ID = Number(process.env.ADMIN_ID);

// ===== UPI DETAILS =====
const UPI_ID = "pradyutnaskar10-6@okaxis";
const UPI_NAME = "pradyut naskar";

let userState = {};
let lastMessageTime = {};

// ===== SERVICES =====
const services = {
    "1000_500": { name: "1000 pe 500", price: 8 },
    "500_500": { name: "500 pe 500", price: 16 },
    "1000_1000": { name: "1000 pe 1000", price: 67 },
    "2000_2000": { name: "2000 pe 2000", price: 124 },
    "4000_4000": { name: "4000 pe 4000", price: 288 }
};

// ===== ORDER STORAGE =====
function loadOrders() {
    if (!fs.existsSync("orders.json")) return {};
    return JSON.parse(fs.readFileSync("orders.json"));
}

function saveOrders(data) {
    fs.writeFileSync("orders.json", JSON.stringify(data, null, 2));
}

// ===== STOCK CHECK =====
function checkStock(serviceKey) {
    let filename = `coupons_${serviceKey}.txt`;
    if (!fs.existsSync(filename)) return 0;

    let coupons = fs.readFileSync(filename, "utf-8")
        .split("\n")
        .map(c => c.trim())
        .filter(c => c !== "");

    return coupons.length;
}

// ===== GET MULTIPLE COUPONS =====
function getMultipleCoupons(serviceKey, quantity) {
    let filename = `coupons_${serviceKey}.txt`;
    if (!fs.existsSync(filename)) return [];

    let coupons = fs.readFileSync(filename, "utf-8")
        .split("\n")
        .map(c => c.trim())
        .filter(c => c !== "");

    if (coupons.length < quantity) return [];

    let selected = coupons.slice(0, quantity);
    let remaining = coupons.slice(quantity);

    fs.writeFileSync(filename, remaining.join("\n"));
    return selected;
}

// ===== START =====
bot.onText(/\/start/, (msg) => {

    delete userState[msg.chat.id];

    bot.sendMessage(msg.chat.id,
        `👋 Welcome ${msg.from.first_name}`,
        {
            reply_markup: {
                keyboard: [["🛒 Buy Coupon", "🔄 Recovery"]],
                resize_keyboard: true
            }
        }
    );
});

// ===== MESSAGE HANDLER =====
bot.on("message", async (msg) => {

    if (msg.from.is_bot) return;

    const chatId = msg.chat.id;

    // Anti-spam 2 sec
    let now = Date.now();
    if (lastMessageTime[chatId] && now - lastMessageTime[chatId] < 2000) return;
    lastMessageTime[chatId] = now;

    // BUY BUTTON
    if (msg.text === "🛒 Buy Coupon") {
        return bot.sendMessage(chatId,
            "💎 Select a Service",
            {
                reply_markup: {
                    inline_keyboard: Object.keys(services).map(key => [
                        {
                            text: `${services[key].name} | ₹${services[key].price}`,
                            callback_data: `service_${key}`
                        }
                    ])
                }
            }
        );
    }

    // QUANTITY STEP
    if (userState[chatId]?.step === "quantity") {

        if (!msg.text || isNaN(msg.text)) {
            return bot.sendMessage(chatId, "❌ Enter valid quantity");
        }

        let qty = parseInt(msg.text);
        if (qty <= 0) {
            return bot.sendMessage(chatId, "❌ Enter valid quantity");
        }

        let service = userState[chatId].service;
        let serviceKey = userState[chatId].serviceKey;

        let stock = checkStock(serviceKey);

        if (stock <= 0) {
            delete userState[chatId];
            return bot.sendMessage(chatId, "❌ Out of Stock");
        }

        if (qty > stock) {
            return bot.sendMessage(chatId, `⚠️ Only ${stock} coupons available`);
        }

        let amount = service.price * qty;
        let orderId = "ORD" + uuidv4().slice(0, 6).toUpperCase();

        let orders = loadOrders();

        orders[orderId] = {
            orderId,
            userId: chatId,
            service: service.name,
            serviceKey,
            quantity: qty,
            amount,
            status: "pending",
            coupon: null,
            createdAt: Date.now()
        };

        saveOrders(orders);

        let paymentText = `upi://pay?pa=${UPI_ID}&pn=${UPI_NAME}&am=${amount}&cu=INR`;
        let qr = await QRCode.toBuffer(paymentText);

        await bot.sendPhoto(chatId, qr, {
            caption:
                `🆔 Order ID: ${orderId}\n` +
                `💰 Amount: ₹${amount}\n\n` +
                `Send payment screenshot`,
            reply_markup: {
                inline_keyboard: [
                    [{ text: "❌ Cancel", callback_data: "cancel_order" }]
                ]
            }
        });

        userState[chatId] = {
            step: "await_screenshot",
            orderId
        };

        return;
    }

    // SCREENSHOT
    if (msg.photo && userState[chatId]?.step === "await_screenshot") {

        let orderId = userState[chatId].orderId;
        let orders = loadOrders();

        orders[orderId].status = "waiting_admin";
        saveOrders(orders);

        await bot.forwardMessage(ADMIN_ID, chatId, msg.message_id);

        await bot.sendMessage(ADMIN_ID,
            `📸 Payment Screenshot\nOrder: ${orderId}`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "✅ Approve", callback_data: `approve_${orderId}` }],
                        [{ text: "❌ Reject", callback_data: `reject_${orderId}` }]
                    ]
                }
            }
        );

        bot.sendMessage(chatId, "🟠 Waiting for approval");
        delete userState[chatId];
    }

    // RECOVERY
    if (msg.text === "🔄 Recovery") {
        userState[chatId] = { step: "recovery" };
        return bot.sendMessage(chatId, "Enter Order ID:");
    }

    if (userState[chatId]?.step === "recovery") {

        let orders = loadOrders();
        let id = msg.text.trim().toUpperCase();

        if (!orders[id])
            return bot.sendMessage(chatId, "❌ Invalid Order ID");

        let o = orders[id];

        let text =
            `📦 Order: ${o.orderId}\n` +
            `📌 Status: ${o.status}`;

        if (o.status === "approved")
            text += `\n\n🎁 Coupons:\n${o.coupon}`;

        bot.sendMessage(chatId, text);
        delete userState[chatId];
    }
});

// ===== CALLBACK =====
bot.on("callback_query", async (query) => {

    const data = query.data;
    const chatId = query.message.chat.id;

    // CANCEL
    if (data === "cancel_order") {
        delete userState[chatId];

        bot.answerCallbackQuery(query.id, { text: "Order Cancelled ❌" });
        return bot.sendMessage(chatId, "Order cancelled.");
    }

    // SERVICE SELECT
    if (data.startsWith("service_")) {

        let key = data.replace("service_", "");
        let stock = checkStock(key);

        if (stock <= 0) {
            return bot.answerCallbackQuery(query.id, {
                text: "❌ Out of Stock",
                show_alert: true
            });
        }

        userState[chatId] = {
            step: "quantity",
            service: services[key],
            serviceKey: key
        };

        bot.answerCallbackQuery(query.id);
        return bot.sendMessage(chatId, "Enter quantity:");
    }

    // ADMIN ONLY CHECK
    if (query.from.id !== ADMIN_ID) {
        return bot.answerCallbackQuery(query.id, {
            text: "❌ Admin Only",
            show_alert: true
        });
    }

    // APPROVE
    if (data.startsWith("approve_")) {

        let orderId = data.replace("approve_", "");
        let orders = loadOrders();
        if (!orders[orderId]) return;

        let order = orders[orderId];

        let coupons = getMultipleCoupons(order.serviceKey, order.quantity);
        if (coupons.length === 0) {
            return bot.sendMessage(ADMIN_ID, "❌ Not enough coupons!");
        }

        order.status = "approved";
        order.coupon = coupons.join("\n");
        saveOrders(orders);

        bot.sendMessage(
            order.userId,
            `🟢 Payment Approved!\n\n🎁 Your Coupons:\n\n${coupons.join("\n")}`
        );

        bot.answerCallbackQuery(query.id, { text: "Approved ✅" });
    }

    // REJECT
    if (data.startsWith("reject_")) {

        let orderId = data.replace("reject_", "");
        let orders = loadOrders();
        if (!orders[orderId]) return;

        orders[orderId].status = "rejected";
        saveOrders(orders);

        bot.sendMessage(
            orders[orderId].userId,
            "🔴 Payment Rejected"
        );

        bot.answerCallbackQuery(query.id, { text: "Rejected ❌" });
    }
});

// ===== AUTO CLEAR PENDING (10 MIN) =====
setInterval(() => {

    let orders = loadOrders();
    let changed = false;

    for (let id in orders) {
        if (orders[id].status === "pending") {
            if (Date.now() - orders[id].createdAt > 10 * 60 * 1000) {
                delete orders[id];
                changed = true;
            }
        }
    }

    if (changed) saveOrders(orders);

}, 5 * 60 * 1000);

console.log("🔥 PRO BUSINESS BOT RUNNING");
const express = require("express");
const app = express();

app.get("/", (req, res) => {
  res.send("Bot is running");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

