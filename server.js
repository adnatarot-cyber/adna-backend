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

const BOOKING_URL = process.env.BOOKING_URL || "https://adnainfinity.com";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const app = express();

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

function detectIntent(text = "") {
  const t = text.toLowerCase();

  const reservar = [
    "quiero reservar",
    "quiero agendar",
    "agendar",
    "reservar",
    "reserva",
    "cita",
    "quiero cita",
    "pásame el enlace",
    "pasame el enlace",
    "quiero hacerlo",
    "quiero esa",
    "esa misma",
    "la 1",
    "la 2",
    "la 3",
    "la 4",
    "si quiero reservar",
    "sí quiero reservar",
    "quiero la express",
    "quiero el pack",
    "quiero 30",
    "quiero 60",
    "videollamada",
    "video llamada",
    "la express",
    "pack express",
    "30 min",
    "60 min",
    "agendar consulta",
    "agendar cita",
    "quiero una consulta",
    "quiero una sesión",
    "quiero una sesion",
    "quiero hablar con adna",
    "quiero reservar una consulta",
  ];

  const precios = [
    "precio",
    "precios",
    "cuánto cuesta",
    "cuanto cuesta",
    "cuánto vale",
    "cuanto vale",
    "tarifa",
  ];

  const comparacion = [
    "qué diferencia",
    "que diferencia",
    "cuál me recomiendas",
    "cual me recomiendas",
    "qué me conviene",
    "que me conviene",
    "cuál es mejor",
    "cual es mejor",
    "qué opción me va mejor",
    "que opcion me va mejor",
    "qué consulta me recomiendas",
    "que consulta me recomiendas",
  ];

  const saludo = [
    "hola",
    "buenas",
    "hey",
    "holi",
    "ola",
    "buenos días",
    "buenas tardes",
    "buenas noches",
  ];

  if (reservar.some((k) => t.includes(k))) return "ready_to_book";
  if (comparacion.some((k) => t.includes(k))) return "comparing";
  if (precios.some((k) => t.includes(k))) return "price_check";
  if (saludo.some((k) => t === k || t.startsWith(k + " "))) return "greeting";
  return "general";
}

function detectStage(history = []) {
  const userMessages = history
    .filter((m) => m.role === "user")
    .map((m) => m.content.toLowerCase());

  const hasAskedPrice = userMessages.some((m) =>
    ["precio", "precios", "cuánto", "cuanto", "vale", "tarifa"].some((k) =>
      m.includes(k)
    )
  );

  const hasMentionedBooking = userMessages.some((m) =>
    ["reservar", "agendar", "cita", "enlace", "quiero hacerlo"].some((k) =>
      m.includes(k)
    )
  );

  if (hasMentionedBooking) return "hot";
  if (hasAskedPrice) return "warm";
  return "cold";
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
    return res.status(400).json({ error: "El campo 'message' es obligatorio." });
  }

  if (!sessionId) {
    return res
      .status(400)
      .json({ error: "El campo 'sessionId' es obligatorio." });
  }

  const history = sanitizeHistory(rawHistory);

  let cliente = null;

  try {
    cliente = await db.upsertCliente(sessionId);
  } catch (err) {
    console.error("Supabase upsertCliente:", err.message);
  }

  if (cliente) {
    try {
      await db.guardarMensaje(cliente.id, "user", message);

      const nombreDetectado = db.detectarNombre(message);
      const tipoDetectado = db.detectarTipoInteres(message);
      const updates = {};

      if (nombreDetectado && !cliente.nombre) {
        updates.nombre = nombreDetectado;
      }

      if (tipoDetectado && !cliente.tipo_interes) {
        updates.tipo_interes = tipoDetectado;
      }

      if (Object.keys(updates).length > 0) {
        await db.actualizarCliente(cliente.id, updates);
        cliente = { ...cliente, ...updates };
      }
    } catch (err) {
      console.error("Error guardando cliente:", err.message);
    }
  }

  const currentIntent = detectIntent(message);
  const currentStage = detectStage(history);
  const knownName = cliente?.nombre || "";

  const SYSTEM_PROMPT = `Eres "Luz", la asistente de atención de Adna Infinity.

Tu función es recibir a las personas que llegan al chat, entender qué les preocupa y orientarlas con cercanía hacia la consulta que más puede ayudarles.

Tu estilo debe ser:
- cálido
- cercano
- humano
- empático
- espiritual pero práctico
- claro
- breve

Usa emojis suaves como:
✨ 💫 🔮

REGLAS:
- No suenes como catálogo.
- Primero escucha el problema.
- No enumeres servicios si aún no sabes qué le pasa.
- Nunca pegues la URL directamente.
- Cuando toque reservar usa exactamente:
[BOOKING_BUTTON]

SERVICIOS DISPONIBLES:
1. Consulta Express Tarot — 1 pregunta — audio — 18 €
2. Pack Express Tarot — 3 preguntas — audio — 50 €
3. Consulta Tarot 30 min — videollamada Instagram o voz — 45 €
4. Consulta Tarot 60 min — videollamada Instagram o voz — 85 €

IMPORTANTE:
Las videollamadas no se hacen por WhatsApp.

Si la persona quiere reservar usa:
[BOOKING_BUTTON]

CONTEXTO:
Nombre conocido: ${knownName || "desconocido"}
Intención detectada: ${currentIntent}
Temperatura comercial: ${currentStage}

Responde adaptándote a la situación emocional del cliente.
`;

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: message },
  ];

  let reply;

  try {
    const response = await openai.chat.completions.create({
      model: CONFIG.openaiModel,
      messages,
      max_tokens: 400,
      temperature: 0.7,
    });

    reply = cleanReply(
      response.choices?.[0]?.message?.content ||
        "Lo siento, ahora mismo no puedo responder."
    );
  } catch (err) {
    console.error("OpenAI error:", err);
    reply = "Ahora mismo no puedo responder. Inténtalo en unos segundos.";
  }

  if (cliente) {
    try {
      await db.guardarMensaje(cliente.id, "assistant", reply);

      if (
        cliente.estado_lead === "nuevo" &&
        (currentIntent === "ready_to_book" || reply.includes("[BOOKING_BUTTON]"))
      ) {
        await db.actualizarCliente(cliente.id, { estado_lead: "interesado" });
      }
    } catch (err) {
      console.error("Error guardando respuesta:", err.message);
    }
  }

  return res.json({
    reply,
    clienteId: cliente?.id || null,
    meta: {
      intent: currentIntent,
      stage: currentStage,
    },
  });
});

/* ════════════════════════════════════════════════
   START
════════════════════════════════════════════════ */

app.listen(CONFIG.port, () => {
  console.log(`Servidor Adna Infinity en puerto ${CONFIG.port}`);
  console.log(`Modelo: ${CONFIG.openaiModel}`);
  console.log(`Booking: ${BOOKING_URL}`);
});

