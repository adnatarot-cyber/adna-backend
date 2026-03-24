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
   LUZ — SYSTEM PROMPT
════════════════════════════════════════════════ */

const SYSTEM_PROMPT = `Eres Luz, asistente de Adna Infinity.

OBJETIVO
- Entender rápido qué quiere el cliente.
- Responder breve, claro y con seguridad.
- Recomendar lo necesario.
- Llevar siempre a reserva cuando tenga sentido.

ESTILO
- Respuestas cortas.
- Sin rodeos.
- No explicaciones largas.
- Sonido humano, cercano y seguro.
- Máximo 2-4 líneas por mensaje.
- Emojis con moderación.

REGLAS
- Si el cliente ya sabe que quiere reservar, ir directo a cierre.
- Si pide precio, responder directo y breve.
- Si duda, recomendar una sola opción.
- No regalar consultas ni lecturas completas gratis.
- No dejar conversaciones abiertas sin CTA.
- No usar markdown, ni asteriscos, ni enlaces pegados manualmente.
- Para reservar usa solo [BOOKING_BUTTON].

LÓGICA DE SERVICIOS
- Tarot: cuando quiere saber qué siente alguien, qué va a pasar, tiene dudas o necesita claridad.
- Ritual: cuando quiere volver con alguien, no le habla, hay bloqueo, quiere atraer, recuperar o mover energía.

PRECIOS (solo si los pide)
- Pregunta Express: 18€
- Pack Express: 50€
- Sesión Tarot 30 min: 45€
- Sesión Tarot 60 min: 85€
- Rituales: consultar precio

COMPORTAMIENTO
- Si el cliente dice "quiero reservar", "quiero consulta", "precio", "cómo agendo", no lo marees.
- Responde directo.
- Si ya tienes su nombre, úsalo natural.
- Si aún no lo tienes y la conversación va a continuar, pídelo de forma breve.
- Si el cliente está caliente, cierra con [BOOKING_BUTTON].

EJEMPLOS
- "precio tarot" → responder breve con la opción y cerrar.
- "quiero una consulta" → pedir nombre si hace falta y cerrar con [BOOKING_BUTTON].
- "mi ex no me habla" → recomendar ritual o tarot según contexto, y cerrar.

[BOOKING_BUTTON] es un marcador del frontend. Úsalo solo cuando toque cerrar.`;

/* ════════════════════════════════════════════════
   CHAT — HELPERS
════════════════════════════════════════════════ */

function detectIntent(message) {
  const m = message.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  if (/^(hola|buenas|buenos dias|buenas tardes|buenas noches|hey|ei|ey)\b/.test(m.trim())) return "greeting";
  if (/hablar con adna|hablar con ana|contactar con adna|quiero hablar con ella|prefiero hablar con adna|hablar directamente/.test(m)) return "wants_adna";
  if (/reservar|agendar|quiero cita|quiero una sesion|quiero consulta|necesito cita|pedir cita|quiero pedir|quiero una cita/.test(m)) return "booking";
  if (/si,? quiero|vale,? perfecto|me interesa|vamos|adelante|lo quiero|me apunto|reservo/.test(m)) return "ready";
  if (/ahora no|de momento no|luego|mas adelante|no gracias|ya te digo|lo pienso/.test(m)) return "not_now";
  if (/consulta de tarot|tirada de tarot|lectura de tarot|quiero una consulta|quiero tarot|sesion de tarot|una tirada/.test(m)) return "general_tarot";
  if (/express|tirada express|pregunta express|pack express|sesion de 30|sesion de 60|30 minutos|60 minutos|como funciona/.test(m)) return "service_info";
  if (/precio|cuanto|cuanto cuesta|tarifas|que opciones|cuanto vale/.test(m)) return "prices";
  if (/ritual|endulzamiento|retorno|limpieza energetica|arrasa todo|pasion|rompeunion|san alejo|velas|energia negativa|trabajo espiritual|amarre/.test(m)) return "ritual";
  if (/pregunta rapida|duda puntual|una cosa|solo quiero saber|pregunta concreta|duda concreta/.test(m)) return "quick";
  if (/no se que hacer|estoy perdid|necesito orientacion|me siento|estoy bloquead|crisis|confundid|agobiad|angustiad|sufr|desesper|no puedo mas|ayuda/.test(m)) return "deep";
  if (/me llamo |soy |mi nombre es /.test(m) && m.length < 60) return "gives_name";

  return "general";
}

function detectStage(history) {
  const userMsgs = history.filter((h) => h.role === "user").length;
  if (userMsgs <= 1) return "cold";
  if (userMsgs <= 3) return "warm";
  return "hot";
}

function extractName(history) {
  for (const msg of history) {
    if (msg.role === "user") {
      const m = msg.content.toLowerCase();
      const match = m.match(/(?:me llamo|soy|mi nombre es)\s+([a-záéíóúñ]+)/i);
      if (match) return match[1].charAt(0).toUpperCase() + match[1].slice(1);
    }
  }
  return null;
}

function hasAskedForName(history) {
  return history.some(
    (msg) =>
      msg.role === "assistant" &&
      /(?:tu nombre|dime tu nombre|cómo te llamas|como te llamas|dirigirme a ti)/i.test(msg.content)
  );
}

/* ════════════════════════════════════════════════
   CHAT
════════════════════════════════════════════════ */

app.post("/chat", async (req, res) => {
  const rawMessage = req.body?.message;
  const rawHistory = req.body?.history;
  const rawSessionId = req.body?.sessionId;
  const assistantProfile = req.body?.assistantProfile || null;

  const message = sanitizeText(rawMessage, 2000);
  const sessionId = sanitizeText(rawSessionId, 200);

  if (!message) {
    return res.status(400).json({ error: "El campo 'message' es obligatorio." });
  }

  if (!sessionId) {
    return res.status(400).json({ error: "El campo 'sessionId' es obligatorio." });
  }

  const history = sanitizeHistory(rawHistory);
  const intent = detectIntent(message);
  const stage = detectStage(history);
  const clientName = extractName([...history, { role: "user", content: message }]);
  const alreadyAskedName = hasAskedForName(history);

  let hints = [];

  if (clientName) {
    hints.push(`[NOMBRE DEL CLIENTE: ${clientName}. Úsalo con naturalidad.]`);
  } else if (!alreadyAskedName && stage !== "cold") {
    hints.push("[AÚN NO CONOCES EL NOMBRE. Pídelo pronto de forma natural si la conversación continúa.]");
  }

  switch (intent) {
    case "greeting":
      hints.push("[SALUDO. Preséntate breve y pregunta qué necesita. No listes servicios.]");
      break;
    case "wants_adna":
      hints.push("[QUIERE HABLAR CON ADNA. Responde con tacto que estás tú al frente y ayuda sin sonar brusca.]");
      break;
    case "booking":
      hints.push("[QUIERE RESERVAR. Si no tienes su nombre, pídelo. Si ya lo tienes, cierra con [BOOKING_BUTTON].]");
      break;
    case "ready":
      hints.push("[ESTÁ DECIDIDO. Cierra directamente con [BOOKING_BUTTON].]");
      break;
    case "not_now":
      hints.push("[NO QUIERE AGENDAR AHORA. Cierra amablemente sin presión.]");
      break;
    case "service_info":
      hints.push("[PREGUNTA POR UN SERVICIO CONCRETO. Explica breve y claro. Si hay interés, ofrece reserva.]");
      break;
    case "general_tarot":
      hints.push("[PIDE TAROT EN GENERAL. Explica muy breve las opciones (Express, 30 min, 60 min) y pregunta cuál le encaja o si quiere recomendación.]");
      break;
    case "prices":
      hints.push("[PIDE PRECIOS. Responde breve y, si encaja, cierra con reserva.]");
      break;
    case "ritual":
      hints.push("[INTERÉS EN RITUALES. Explica para qué sirve. No expliques cómo se hace. Orienta a reservar.]");
      break;
    case "quick":
      hints.push("[DUDA PUNTUAL. Valora Pregunta Express o Pack Express.]");
      break;
    case "deep":
      hints.push("[MOMENTO EMOCIONAL. Contén con brevedad y empatía. Recomienda sesión profunda. No recomiendes express.]");
      break;
    case "gives_name":
      hints.push("[ACABA DE DAR SU NOMBRE. Agradécelo natural y sigue ayudando.]");
      break;
    default:
      hints.push("[RESPONDE BREVE, CLARO Y LLEVA A LA ACCIÓN SI HAY INTENCIÓN.]");
      break;
  }

  if (stage === "hot" && intent !== "not_now") {
    hints.push("[CLIENTE CALIENTE. Si muestra interés, intenta cerrar con [BOOKING_BUTTON].]");
  }

  let dynamicProfileBlock = "";
  if (assistantProfile) {
    dynamicProfileBlock = `
PERFIL ACTUAL DE LUZ
- Identidad: ${assistantProfile.identity || "Luz, asistente de Adna Infinity"}
- Estilo: ${assistantProfile.style || "respuestas cortas, claras y directas"}
- Prioridades:
${Array.isArray(assistantProfile.priorities) ? assistantProfile.priorities.map((p) => `- ${p}`).join("\n") : "- cerrar con acción"}
- Reglas:
${Array.isArray(assistantProfile.rules) ? assistantProfile.rules.map((r) => `- ${r}`).join("\n") : "- no regalar consultas"}
- Booking URL: ${assistantProfile.bookingUrl || BOOKING_URL}
`;
  }

  const contextBlock = hints.length ? "\n\n" + hints.join("\n") : "";
  const finalSystemPrompt = `${SYSTEM_PROMPT}\n${dynamicProfileBlock}${contextBlock}`;

  let reply;

  try {
    const response = await openai.chat.completions.create({
      model: CONFIG.openaiModel,
      messages: [
        { role: "system", content: finalSystemPrompt },
        ...history,
        { role: "user", content: message },
      ],
      max_tokens: 350,
      temperature: 0.6,
    });

    reply = cleanReply(
      response.choices?.[0]?.message?.content?.trim() ||
        "Lo siento, ha ocurrido un problema."
    );
  } catch (err) {
    console.error("OpenAI error:", err?.message || err);
    reply = "En este momento no puedo responder. Por favor intenta de nuevo.";
  }

  return res.json({ reply });
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
   TELEGRAM NOTIFICACIÓN NUEVA RESERVA
════════════════════════════════════════════════ */

app.post("/api/notify-booking-telegram", async (req, res) => {
  try {
    const {
      clientName,
      clientContact,
      clientEmail,
      serviceName,
      bookingDate,
      bookingTime,
      paymentMethod,
      questions,
      bookingId,
    } = req.body;

    if (!clientName || !serviceName || !bookingDate) {
      return res.status(400).json({
        error: "Faltan datos obligatorios (clientName, serviceName, bookingDate)",
      });
    }

    const msg = [
      "🔔 Nueva reserva Adna Tarot",
      "",
      `👤 Nombre: ${clientName}`,
      `📞 Teléfono: ${clientContact || "No indicado"}`,
      `📧 Email: ${clientEmail || "No indicado"}`,
      `🔮 Servicio: ${serviceName}`,
      `📅 Fecha: ${bookingDate}`,
      `⏰ Hora: ${bookingTime || "Sin hora"}`,
      `💳 Pago: ${paymentMethod || "No indicado"}`,
      `📝 Consulta: ${questions || "No indicada"}`,
    ].join("\n");

    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
      console.error("Telegram: TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID no configurados");
      return res.status(500).json({ error: "Telegram no configurado" });
    }

    const body = {
      chat_id: chatId,
      text: msg,
    };

    if (bookingId) {
      body.reply_markup = {
        inline_keyboard: [
          [
            {
              text: "✅ Verificar reserva",
              url: `https://dashboard-soft-queijadas-b936a3.netlify.app/?section=pagos&bookingId=${bookingId}`,
            },
          ],
        ],
      };
    }

    const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!tgRes.ok) {
      const errBody = await tgRes.text();
      throw new Error(`Telegram API error: ${tgRes.status} - ${errBody}`);
    }

    res.json({ ok: true });
  } catch (error) {
    console.error("Error enviando Telegram:", error);
    res.status(500).json({ error: "No se pudo enviar Telegram" });
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
