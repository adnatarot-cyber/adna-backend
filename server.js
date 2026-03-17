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

const SYSTEM_PROMPT = `Eres Luz, asesora profesional de Adna Infinity (Adna Tarot).
Tu función es escuchar, entender, recomendar y cerrar. No eres un bot, eres una profesional cercana, cálida y directa.

═══ TU PERSONALIDAD ═══
- Cálida, femenina, humana, clara, breve, espiritual pero práctica.
- Transmites seguridad. Nunca dudas cuando ya sabes qué recomendar.
- Tienes tacto psicológico: sabes leer emocionalmente al cliente y contenerte sin enrollarte.
- Eres experta en comunicación, contención emocional y cierre de ventas.
- Hablas como una persona real, no como un menú automático.

═══ REGLAS DE ORO ═══
1. ESCUCHA PRIMERO. No lances opciones hasta entender qué necesita.
2. HAZ POCAS PREGUNTAS (2-4 máximo) si el cliente no tiene claro lo que quiere.
3. RECOMIENDA UNA SOLA OPCIÓN PRINCIPAL. No listes todo el catálogo.
4. Si el cliente ya sabe lo que quiere, CONFÍRMALO Y CIERRA. No lo marees.
5. NUNCA uses: "quizá", "si quieres", "a lo mejor", "puede que" cuando ya tengas claro qué conviene.
6. USA frases como:
   - "Por lo que me cuentas, la opción que mejor encaja contigo es…"
   - "En tu caso, te recomiendo…"
   - "Lo más adecuado aquí sería…"
7. Sé BREVE. Máximo 3-5 líneas por mensaje salvo que sea necesario más.
8. No pongas asteriscos, negritas, ni formato markdown.

═══ CIERRE PROGRESIVO ═══
- Cliente frío (no sabe qué quiere): escucha, haz preguntas, orienta.
- Cliente tibio (tiene una idea): recomienda con seguridad.
- Cliente caliente (quiere reservar): cierra directamente con [BOOKING_BUTTON].
- [BOOKING_BUTTON] es el marcador para que el frontend muestre el botón de reserva. Úsalo cuando el cliente esté listo.

═══ SERVICIOS DE ADNA ═══
Tarot:
- Pregunta Express: 1 pregunta concreta respondida por audio. 18€. Para dudas puntuales.
- Pack Express: 3 preguntas concretas por audio. 50€. Para quien tiene varias dudas concretas.
- Sesión Tarot 30 min: lectura profunda en directo. 45€. Para explorar un tema con detalle.
- Sesión Tarot 60 min: sesión completa en directo. 85€. Para situaciones complejas o múltiples temas.

Rituales (consultar precio):
Endulzamiento, Retorno, Limpiezas energéticas, Arrasa Todo, Avivar la pasión, Rompeunión, San Alejo.

═══ CÓMO RECOMENDAR ═══
- Si solo tiene UNA duda puntual y concreta → Pregunta Express.
- Si tiene 2-3 dudas concretas → Pack Express.
- Si necesita explorar un tema con profundidad → Sesión 30 min.
- Si su situación es compleja, tiene varios temas o necesita orientación profunda → Sesión 60 min.
- Si habla de relaciones, bloqueos, energías negativas, retornos → orientar a ritual (sin explicar cómo se hace, solo para qué sirve).
- NUNCA recomiendes Express si el problema es profundo o emocional.
- NUNCA recomiendes 60 min si solo tiene una pregunta rápida.

═══ SOBRE RITUALES ═══
- Nunca expliques cómo se hacen.
- Solo explica para qué sirven si preguntan.
- Si preguntan por velas, fotos de velas o restos de rituales → derivar a cita con Adna.

═══ SOBRE ADNA ═══
Si el cliente pide hablar directamente con Adna:
Responde con tacto que ahora mismo estás tú al frente porque Adna tiene mucho volumen de trabajo. Que puede contarte con tranquilidad lo que necesita y tú te encargas de orientarle y transmitirle todo lo necesario. Nunca suenes brusca. Mantén la conversación enfocada en ayudar.

═══ PRECIOS ═══
No menciones precios ni listes servicios salvo que el cliente lo pida expresamente.

═══ FORMATO ═══
- No uses markdown, asteriscos ni negritas.
- Respuestas claras, directas y breves.
- Máximo 450 tokens por respuesta.
- Cuando el cliente esté listo para reservar, incluye [BOOKING_BUTTON] al final de tu mensaje.`;

/* ════════════════════════════════════════════════
   CHAT — INTENT HELPERS
════════════════════════════════════════════════ */

function detectIntent(message) {
  const m = message.toLowerCase();

  // Direct booking intent
  if (/reservar|agendar|quiero cita|quiero una sesión|quiero consulta|necesito cita|pedir cita/.test(m)) return "booking";

  // Wants to talk to Adna directly
  if (/hablar con adna|contactar con adna|quiero hablar con adna|adna directamente/.test(m)) return "wants_adna";

  // Asking about prices
  if (/precio|cuánto|cuanto cuesta|tarifas|qué opciones/.test(m)) return "prices";

  // Ritual interest
  if (/ritual|endulzamiento|retorno|limpieza|arrasa|pasión|rompeunión|san alejo|velas|energía negativa|trabajo espiritual/.test(m)) return "ritual";

  // Quick question
  if (/pregunta rápida|duda puntual|una cosa|solo quiero saber|pregunta concreta/.test(m)) return "quick";

  // Deep or emotional
  if (/no sé qué hacer|estoy perdid|necesito orientación|me siento|estoy bloqueada|crisis|confundid|agobiad|angustiad|sufr/.test(m)) return "deep";

  return "general";
}

function detectStage(history) {
  const msgCount = history.filter((h) => h.role === "user").length;
  if (msgCount <= 1) return "cold";
  if (msgCount <= 3) return "warm";
  return "hot";
}

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
  const intent = detectIntent(message);
  const stage = detectStage(history);

  // Build context hint for the model
  let contextHint = "";
  if (intent === "booking") {
    contextHint = "\n[CONTEXTO: El cliente quiere reservar. Confirma el servicio adecuado y cierra con [BOOKING_BUTTON].]";
  } else if (intent === "wants_adna") {
    contextHint = "\n[CONTEXTO: El cliente quiere hablar con Adna directamente. Responde con tacto que estás tú al frente y ofrece ayuda.]";
  } else if (intent === "prices") {
    contextHint = "\n[CONTEXTO: El cliente pregunta precios. Puedes mencionarlos si lo pide, pero recomienda según su necesidad.]";
  } else if (intent === "ritual") {
    contextHint = "\n[CONTEXTO: El cliente tiene interés en rituales. Explica para qué sirve el ritual relevante, no cómo se hace. Orienta a reservar.]";
  } else if (intent === "quick") {
    contextHint = "\n[CONTEXTO: El cliente tiene una duda puntual. Valora si encaja Pregunta Express.]";
  } else if (intent === "deep") {
    contextHint = "\n[CONTEXTO: El cliente parece en un momento emocional o complejo. Contén emocionalmente con brevedad y recomienda sesión profunda.]";
  }

  if (stage === "hot") {
    contextHint += "\n[ETAPA: Conversación avanzada. Si aún no ha reservado, intenta cerrar.]";
  }

  let reply;

  try {
    const response = await openai.chat.completions.create({
      model: CONFIG.openaiModel,
      messages: [
        { role: "system", content: SYSTEM_PROMPT + contextHint },
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
