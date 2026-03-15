// ════════════════════════════════════════════════
// ADNA INFINITY — Backend con Supabase
// server.js
// ════════════════════════════════════════════════

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");
const db = require("./db");

const CONFIG = {
  port: process.env.PORT || 3000,
  openaiModel: process.env.OPENAI_MODEL || "gpt-4o-mini",
  allowedOrigins: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
    : ["*"],
};

const BOOKING_URL =
  process.env.BOOKING_URL || "https://adnainfinity.com";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const app = express();

/* ════════════════════════════════════════════════
   EMAIL (Resend)
════════════════════════════════════════════════ */

const { Resend } = require("resend");
const resend = new Resend(process.env.RESEND_API_KEY);

/* ════════════════════════════════════════════════
   CORS
════════════════════════════════════════════════ */

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);

    if (CONFIG.allowedOrigins.includes("*")) {
      return callback(null, true);
    }

    if (CONFIG.allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error("Origen no permitido por CORS: " + origin));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json({ limit: "10kb" }));

/* ════════════════════════════════════════════════
   HELPERS
════════════════════════════════════════════════ */

function sanitizeText(text, maxLen = 2000) {
  if (typeof text !== "string") return "";
  return text.trim().replace(/\s+/g, " ").slice(0, maxLen);
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(
      (item) =>
        item &&
        (item.role === "user" || item.role === "assistant") &&
        typeof item.content === "string"
    )
    .slice(-20)
    .map((item) => ({
      role: item.role,
      content: sanitizeText(item.content, 2000),
    }));
}

function cleanReply(text) {
  if (!text) return "";
  return String(text)
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/__/g, "")
    .replace(/`/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ════════════════════════════════════════════════
   HEALTH
════════════════════════════════════════════════ */

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    model: CONFIG.openaiModel,
    supabase: !!process.env.SUPABASE_URL,
    bookingUrl: BOOKING_URL,
  });
});

/* ════════════════════════════════════════════════
   CHAT
════════════════════════════════════════════════ */

app.post("/chat", async (req, res) => {
  const rawMessage = req.body?.message;
  const rawHistory = req.body?.history;
  const rawSessionId = req.body?.sessionId;

  const message = sanitizeText(rawMessage, 2000);
  const sessionId = sanitizeText(rawSessionId, 200);

  if (!message) {
    return res.status(400).json({
      error: "El campo 'message' es obligatorio.",
    });
  }

  if (!sessionId) {
    return res.status(400).json({
      error: "El campo 'sessionId' es obligatorio.",
    });
  }

  const history = sanitizeHistory(rawHistory);

  let reply;

  try {
    const response = await openai.chat.completions.create({
      model: CONFIG.openaiModel,
      messages: [
        { role: "system", content: "Eres Luz, asistente de Adna Infinity." },
        ...history,
        { role: "user", content: message },
      ],
      max_tokens: 450,
      temperature: 0.7,
    });

    reply = cleanReply(
      response.choices?.[0]?.message?.content?.trim() ||
      "Lo siento, ha ocurrido un problema."
    );
  } catch (err) {
    console.error("OpenAI error:", err?.message || err);
    reply =
      "En este momento no puedo responder. Por favor intenta de nuevo.";
  }

  return res.json({
    reply,
  });
});

/* ════════════════════════════════════════════════
   EMAIL CONFIRMACIÓN RESERVA
════════════════════════════════════════════════ */

app.post("/api/send-booking-confirmation", async (req, res) => {
  try {

    const { clientName, clientEmail, serviceName, bookingDate, bookingTime, duration } = req.body;

    if (!clientName || !clientEmail) {
      return res.status(400).json({
        error: "Faltan datos de cliente"
      });
    }

    const html = `
      <div style="font-family: Arial, sans-serif; color:#2f2a26; line-height:1.6">
        <h2 style="color:#b88a5a;">Confirmación de reserva – Adna Infinity</h2>

        <p>Hola <strong>${clientName}</strong>,</p>

        <p>Tu reserva ha sido recibida correctamente.</p>

        <p><strong>Servicio:</strong> ${serviceName}</p>
        <p><strong>Fecha:</strong> ${bookingDate}</p>
        <p><strong>Hora:</strong> ${bookingTime}</p>
        <p><strong>Duración:</strong> ${duration}</p>

        <p>En breve verificaremos tu pago y confirmaremos tu cita.</p>

        <p>Gracias por confiar en Adna Infinity ✨</p>
      </div>
    `;

    await resend.emails.send({
      from: "Adna Infinity <onboarding@resend.dev>",
      to: clientEmail,
      subject: "Confirmación de reserva – Adna Infinity",
      html,
    });

    res.json({
      ok: true
    });

  } catch (error) {

    console.error("Error enviando email con Resend:", error);

    res.status(500).json({
      error: "No se pudo enviar el email"
    });

  }
});

/* ════════════════════════════════════════════════
   404
════════════════════════════════════════════════ */

app.use((req, res) => {
  res.status(404).json({
    error: "Ruta no encontrada.",
  });
});

/* ════════════════════════════════════════════════
   ERROR HANDLER
════════════════════════════════════════════════ */

app.use((err, req, res, next) => {
  console.error("SERVER ERROR:", err.message || err);

  if (String(err.message || "").includes("CORS")) {
    return res.status(403).json({
      error: "Bloqueado por CORS.",
    });
  }

  return res.status(500).json({
    error: "Error interno del servidor.",
  });
});

/* ════════════════════════════════════════════════
   START
════════════════════════════════════════════════ */

app.listen(CONFIG.port, () => {
  console.log(`✅ Servidor Adna Infinity en puerto ${CONFIG.port}`);
  console.log(`   Modelo:   ${CONFIG.openaiModel}`);
  console.log(
    `   Supabase: ${process.env.SUPABASE_URL ? "✅ conectado" : "⚠️  no configurado"}`
  );
  console.log(`   Booking:  ${BOOKING_URL}`);
});