const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const path = require("path");

const app = express();
app.disable("x-powered-by");
app.use(express.json());

const secret = process.env.JWT_SECRET || "dev-only-change-me";
const DUMMY_HASH = bcrypt.hashSync("not-a-user", 10);
const mongoUrl = process.env.MONGO_URL || process.env.MONGODB_URL || process.env.DATABASE_URL;

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
});
const messageSchema = new mongoose.Schema({
  from: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  to: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  body: { type: String, required: true, maxlength: 2000 },
}, { timestamps: true });
const itemSchema = new mongoose.Schema({
  name: { type: String, required: true },
  kind: { type: String, required: true, enum: ["potion", "weapon", "armor"] },
});
const holdingSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  item: { type: mongoose.Schema.Types.ObjectId, ref: "Item", required: true },
  qty: { type: Number, required: true, min: 1 },
});
holdingSchema.index({ owner: 1, item: 1 }, { unique: true });

const User = mongoose.model("User", userSchema);
const Message = mongoose.model("Message", messageSchema);
const Item = mongoose.model("Item", itemSchema);
const Holding = mongoose.model("Holding", holdingSchema);

function sign(user) {
  return jwt.sign({ sub: String(user._id) }, secret, { expiresIn: "7d" });
}

function requireUser(req, res, next) {
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return res.status(401).json({ error: "missing token" });
  try {
    req.userId = jwt.verify(token, secret).sub;
    next();
  } catch (err) {
    res.status(401).json({ error: "invalid token" });
  }
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/register", async (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!name || !email || password.length < 8) {
    return res.status(400).json({ error: "name, email, and a password of 8+ characters are required" });
  }
  const passwordHash = await bcrypt.hash(password, 12);
  try {
    const user = await User.create({ name, email, passwordHash });
    res.status(201).json({ token: sign(user), user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "email already registered" });
    res.status(500).json({ error: "database" });
  }
});

app.post("/api/login", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const user = await User.findOne({ email });
  const hash = user ? user.passwordHash : DUMMY_HASH;
  const match = await bcrypt.compare(password, hash);
  if (!user || !match) return res.status(401).json({ error: "invalid login" });
  res.json({ token: sign(user), user: { id: user.id, name: user.name, email: user.email } });
});

app.get("/api/items", requireUser, async (req, res) => {
  res.json(await Item.find().sort("name"));
});

app.get("/api/inbox", requireUser, async (req, res) => {
  const rows = await Message.find({ to: req.userId }).populate("from", "name").sort("-createdAt");
  res.json(rows);
});

app.get("/api/messages/:id", requireUser, async (req, res) => {
  const message = await Message.findById(req.params.id).populate("from", "name").populate("to", "name");
  if (!message) return res.status(404).json({ error: "not found" });
  const mine = String(message.from._id || message.from) === req.userId || String(message.to._id || message.to) === req.userId;
  if (!mine) return res.status(403).json({ error: "not your message" });
  res.json(message);
});

app.post("/api/messages", requireUser, async (req, res) => {
  const body = String(req.body.body || "").trim();
  if (!body) return res.status(400).json({ error: "body is required" });
  if (String(req.body.to) === req.userId) return res.status(400).json({ error: "pick someone else" });
  const recipient = await User.findById(req.body.to).select("name");
  if (!recipient) return res.status(404).json({ error: "recipient not found" });
  const message = await Message.create({ from: req.userId, to: recipient.id, body });
  res.status(201).json(message);
});

app.get("/api/pack", requireUser, async (req, res) => {
  const rows = await Holding.find({ owner: req.userId }).populate("item");
  res.json(rows);
});

app.post("/api/holdings", requireUser, async (req, res) => {
  const amount = Number(req.body.amount);
  if (!Number.isInteger(amount) || amount < 1) return res.status(400).json({ error: "amount must be a positive integer" });
  const item = await Item.findById(req.body.item);
  if (!item) return res.status(404).json({ error: "item not found" });
  const holding = await Holding.findOneAndUpdate(
    { owner: req.userId, item: item.id },
    { $inc: { qty: amount }, $setOnInsert: { owner: req.userId, item: item.id } },
    { upsert: true, new: true }
  );
  res.status(201).json(holding);
});

app.post("/api/holdings/transfer", requireUser, async (req, res) => {
  const amount = Number(req.body.amount);
  if (!Number.isInteger(amount) || amount < 1) return res.status(400).json({ error: "amount must be a positive integer" });
  const taken = await Holding.findOneAndUpdate(
    { owner: req.userId, item: req.body.item, qty: { $gte: amount } },
    { $inc: { qty: -amount } },
    { new: true }
  );
  if (!taken) return res.status(409).json({ error: "not enough in your pack" });
  if (taken.qty === 0) await Holding.deleteOne({ _id: taken.id });
  await Holding.findOneAndUpdate(
    { owner: req.body.to, item: req.body.item },
    { $inc: { qty: amount }, $setOnInsert: { owner: req.body.to, item: req.body.item } },
    { upsert: true, new: true }
  );
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, "public")));

async function seed() {
  const count = await Item.countDocuments();
  if (count > 0) return;
  await Item.create([
    { name: "Minor heal", kind: "potion" },
    { name: "Rusty sword", kind: "weapon" },
    { name: "Leather wrap", kind: "armor" },
  ]);
}

async function main() {
  if (!mongoUrl) throw new Error("MONGO_URL is required");
  await mongoose.connect(mongoUrl);
  await seed();
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log("guild hall on " + port));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
