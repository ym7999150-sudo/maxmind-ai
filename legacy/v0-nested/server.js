// ============================================================================
// MuxMind AI — server.js
// High-Concurrency Node.js Express Cluster Backend
// ============================================================================

const cluster = require("cluster");
const os = require("os");

if (cluster.isMaster || cluster.isPrimary) {
  const numCPUs = os.cpus().length;
  console.log(`[MuxMind] Primary ${process.pid} spawning ${numCPUs} workers...`);

  for (let i = 0; i < numCPUs; i++) cluster.fork();

  cluster.on("exit", (worker, code, signal) => {
    console.log(`[MuxMind] Worker ${worker.process.pid} died (${signal || code}). Respawning...`);
    cluster.fork();
  });
} else {
  runWorker();
}

function runWorker() {
  const express = require("express");
  const cors = require("cors");
  const dotenv = require("dotenv");
  const rateLimit = require("express-rate-limit");
  const multer = require("multer");
  const path = require("path");

  dotenv.config();

  const apiManager = require("./src/api-manager");
  const router = require("./src/router");
  const fileParser = require("./src/file-parser");
  const { listProviderMeta } = apiManager;

  const app = express();
  const PORT = process.env.PORT || 3000;

  app.use(cors());
  app.use(express.json({ limit: "10mb" }));
  app.use(express.static(path.join(__dirname)));

  const upload = multer({ dest: "/tmp/muxmind-uploads/" });

  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Rate limit exceeded. Please slow down." },
  });
  app.use("/api/", limiter);

  // ---------------------------------------------------------------------
  // Provider metadata — powers the "Providers" panel with console/API/pricing links
  // ---------------------------------------------------------------------
  app.get("/api/providers", (req, res) => {
    res.json({ providers: listProviderMeta() });
  });

  // ---------------------------------------------------------------------
  // API Key management
  // ---------------------------------------------------------------------
  app.post("/api/keys/:providerId", (req, res) => {
    const { providerId } = req.params;
    const { key } = req.body;
    if (!key) return res.status(400).json({ error: "Missing key" });
    try {
      apiManager.setKey(providerId, key);
      res.json({ success: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/validate/:providerId", async (req, res) => {
    const { providerId } = req.params;
    const { key } = req.body;
    if (!key) return res.status(400).json({ error: "Missing key" });

    const result = await apiManager.validateKey(providerId, key);
    res.json(result);
  });

  // ---------------------------------------------------------------------
  // Chat / routing endpoint
  // ---------------------------------------------------------------------
  app.post("/api/chat", async (req, res) => {
    const { prompt, history, forceProvider, forceModel } = req.body;
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });

    const result = await router.routeAndExecute({
      prompt,
      history: history || [],
      forceProvider: forceProvider || null,
      forceModel: forceModel || null,
    });

    if (!result.success) return res.status(502).json(result);
    res.json(result);
  });

  // ---------------------------------------------------------------------
  // File upload / parsing endpoint
  // ---------------------------------------------------------------------
  app.post("/api/upload", upload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    try {
      const parsed = await fileParser.parseUploadedFile(req.file);
      res.json(parsed);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", worker: process.pid, uptime: process.uptime() });
  });

  app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
  });

  app.listen(PORT, () => {
    console.log(`[MuxMind] Worker ${process.pid} listening on port ${PORT}`);
  });
}
