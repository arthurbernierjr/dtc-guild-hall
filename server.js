// The guild hall: the Unit 4 project from Deeper Than Code, sessions 4-13 and 4-14.
// One Express process. Accounts, an inbox and outbox between them, a catalog of
// items, and a pack of holdings with a quantity that cannot go below zero.
const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const path = require("path");

// Environment. The sessions name MONGODB_URI, JWT_SECRET, PAGE_ORIGIN, and PORT.
// Railway injects MONGO_URL from its MongoDB service, so that name is read second.
const mongoUri = process.env.MONGODB_URI ?? process.env.MONGO_URL;
const secret = process.env.JWT_SECRET;
const pageOrigin = process.env.PAGE_ORIGIN ?? "http://localhost:5173";
const port = process.env.PORT ?? 4100;

const app = express();
app.disable("x-powered-by");
app.use(cors({ origin: pageOrigin }));
app.use(express.json());

// Models.
const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
});

const messageSchema = new mongoose.Schema(
  {
    sender: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    recipient: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    body: { type: String, required: true, trim: true, maxlength: 2000 },
  },
  { timestamps: true }
);

const itemSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  kind: { type: String, required: true, enum: ["potion", "weapon", "armor"] },
});

const holdingSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  item: { type: mongoose.Schema.Types.ObjectId, ref: "Item", required: true },
  qty: { type: Number, required: true, min: 0 },
});
holdingSchema.index({ owner: 1, item: 1 }, { unique: true });

const User = mongoose.model("User", userSchema);
const Message = mongoose.model("Message", messageSchema);
const Item = mongoose.model("Item", itemSchema);
const Holding = mongoose.model("Holding", holdingSchema);

// Accounts. The token's sub is the user id, and its audience is the hall.
const DUMMY_HASH = bcrypt.hashSync("not-a-user", 10);

function sign(user) {
  return jwt.sign({ sub: String(user._id) }, secret, { audience: "guild", expiresIn: "7d" });
}

function publicUser(user) {
  return { id: String(user._id), name: user.name, email: user.email };
}

function requireUser(req, res, next) {
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return res.status(401).json({ error: "missing token" });
  try {
    req.userId = jwt.verify(token, secret, { audience: "guild" }).sub;
    next();
  } catch (err) {
    res.status(401).json({ error: "invalid token" });
  }
}

// Register answers with the account, never the hash. Login answers with the token.
// The id rides along so a second account has something to address a letter to.
app.post("/api/register", async (req, res) => {
  const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
  const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = typeof req.body.password === "string" ? req.body.password : "";
  if (name === "" || email === "" || password.length < 8) {
    return res.status(400).json({ error: "name, email, and a password of 8 or more characters" });
  }
  const passwordHash = await bcrypt.hash(password, 12);
  try {
    const user = await User.create({ name, email, passwordHash });
    res.status(201).json(publicUser(user));
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "email already registered" });
    throw err;
  }
});

app.post("/api/login", async (req, res) => {
  const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = typeof req.body.password === "string" ? req.body.password : "";
  const user = await User.findOne({ email });
  const match = await bcrypt.compare(password, user ? user.passwordHash : DUMMY_HASH);
  if (!user || !match) return res.status(401).json({ error: "invalid credentials" });
  res.json({ token: sign(user), ...publicUser(user) });
});

// Letters. One sender, one recipient. One-to-many from each user.
app.post("/api/messages", requireUser, async (req, res) => {
  const body = typeof req.body.body === "string" ? req.body.body.trim() : "";
  const recipientId = req.body.recipient;
  if (body === "" || !recipientId) return res.status(400).json({ error: "recipient and body are required" });
  if (String(recipientId) === String(req.userId)) return res.status(400).json({ error: "choose another account" });
  const recipient = mongoose.isValidObjectId(recipientId) ? await User.findById(recipientId).select("name") : null;
  if (!recipient) return res.status(404).json({ error: "no such account" });
  const message = await Message.create({ sender: req.userId, recipient: recipient._id, body });
  res.status(201).json(message);
});

app.get("/api/inbox", requireUser, async (req, res) => {
  const rows = await Message.find({ recipient: req.userId }).sort({ createdAt: -1 }).populate("sender", "name");
  res.json(rows);
});

app.get("/api/outbox", requireUser, async (req, res) => {
  const rows = await Message.find({ sender: req.userId }).sort({ createdAt: -1 }).populate("recipient", "name");
  res.json(rows);
});

app.get("/api/messages/:id", requireUser, async (req, res) => {
  const message = mongoose.isValidObjectId(req.params.id)
    ? await Message.findById(req.params.id).populate("sender", "name")
    : null;
  if (!message) return res.status(404).json({ error: "not found" });
  if (String(message.recipient) !== String(req.userId)) return res.status(403).json({ error: "forbidden" });
  res.json(message);
});

// The catalog. What a thing is, shared by everyone, with no quantity.
const CATALOG = [
  { name: "Lamp oil", kind: "potion" },
  { name: "Short sword", kind: "weapon" },
  { name: "Leather coat", kind: "armor" },
];

// Seeding goes through the model, so a fourth kind fails validation instead of
// landing in the collection. A second seed returns what is already there.
app.post("/api/items/seed", requireUser, async (req, res) => {
  const count = await Item.countDocuments();
  if (count > 0) return res.json(await Item.find().sort({ name: 1 }));
  const items = await Item.create(CATALOG);
  res.status(201).json(items);
});

app.get("/api/items", requireUser, async (req, res) => {
  res.json(await Item.find().sort({ name: 1 }));
});

// The pack. A holding joins an owner to an item with a quantity: the many-to-many.
async function credit(ownerId, itemId, amount) {
  return Holding.findOneAndUpdate(
    { owner: ownerId, item: itemId },
    { $inc: { qty: amount }, $setOnInsert: { owner: ownerId, item: itemId } },
    { new: true, upsert: true }
  );
}

async function spend(ownerId, itemId, amount) {
  const updated = await Holding.findOneAndUpdate(
    { owner: ownerId, item: itemId, qty: { $gte: amount } },
    { $inc: { qty: -amount } },
    { new: true }
  );
  if (!updated) {
    const error = new Error("not enough");
    error.status = 409;
    throw error;
  }
  return updated;
}

function readAmount(req) {
  const amount = req.body.amount;
  return Number.isInteger(amount) && amount >= 1 ? amount : null;
}

async function findItem(req) {
  return mongoose.isValidObjectId(req.body.item) ? Item.findById(req.body.item) : null;
}

app.get("/api/pack", requireUser, async (req, res) => {
  const rows = await Holding.find({ owner: req.userId }).populate("item");
  res.json(rows);
});

app.post("/api/pack/give", requireUser, async (req, res) => {
  const amount = readAmount(req);
  if (amount === null) return res.status(400).json({ error: "amount must be a positive integer" });
  const item = await findItem(req);
  if (!item) return res.status(404).json({ error: "unknown item" });
  try {
    const holding = await credit(req.userId, item._id, amount);
    res.status(201).json(holding);
  } catch (err) {
    if (err.code !== 11000) throw err;
    const holding = await Holding.findOneAndUpdate(
      { owner: req.userId, item: item._id },
      { $inc: { qty: amount } },
      { new: true }
    );
    if (!holding) return res.status(409).json({ error: "retry the give" });
    res.status(201).json(holding);
  }
});

// spend throws with a status; the JSON error handler below answers it.
app.post("/api/pack/spend", requireUser, async (req, res) => {
  const amount = readAmount(req);
  if (amount === null) return res.status(400).json({ error: "amount must be a positive integer" });
  const item = await findItem(req);
  if (!item) return res.status(404).json({ error: "unknown item" });
  res.json(await spend(req.userId, item._id, amount));
});

// The debit runs first. If it throws 409, the credit never runs.
app.post("/api/pack/transfer", requireUser, async (req, res) => {
  const amount = readAmount(req);
  if (amount === null) return res.status(400).json({ error: "amount must be a positive integer" });
  const item = await findItem(req);
  if (!item) return res.status(404).json({ error: "unknown item" });
  const recipient = mongoose.isValidObjectId(req.body.to) ? await User.findById(req.body.to).select("name") : null;
  if (!recipient) return res.status(404).json({ error: "no such account" });
  if (String(recipient._id) === String(req.userId)) return res.status(400).json({ error: "choose another account" });
  const debited = await spend(req.userId, item._id, amount);
  const credited = await credit(recipient._id, item._id, amount);
  res.json({ yours: debited, theirs: credited });
});

// A path under /api that matched nothing above is still a JSON answer.
app.use("/api", (req, res) => {
  res.status(404).json({ error: "not found" });
});

// The slate's JSON error handler: a thrown status is the answer, anything else is 500.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.name === "CastError" || err.name === "ValidationError" ? 400 : err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? "server error" : err.message });
});

// The restyled page in public/ is the same hall, served from this process.
app.use(express.static(path.join(__dirname, "public")));

// A URI with no database path (Railway's MONGO_URL) lands in the hall's database.
function dbName(uri) {
  try {
    return new URL(uri).pathname.length > 1 ? undefined : "guildhall";
  } catch (err) {
    return undefined;
  }
}

async function main() {
  if (!mongoUri) throw new Error("set MONGODB_URI (or MONGO_URL) to a MongoDB connection string");
  if (!secret) throw new Error("set JWT_SECRET");
  await mongoose.connect(mongoUri, { dbName: dbName(mongoUri) });
  await Holding.syncIndexes();
  // The live example seeds itself so a visitor sees a catalog without curl.
  // On your machine, POST /api/items/seed does the same thing with a token.
  if ((await Item.countDocuments()) === 0) await Item.create(CATALOG);
  app.listen(port, () => console.log("guild hall on " + port));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
