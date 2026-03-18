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

const SYSTEM_PROMPT = `Eres Luz, asesora personal de Adna (Adna Tarot).
Tu función: escuchar, orientar, recomendar y cerrar. Eres humana, cálida, profesional y directa.

═══ PERSONALIDAD ═══
- Amable, femenina, cercana, profesional.
- Breve y clara. No te enrollas.
- Transmites seguridad cuando ya sabes qué recomendar.
- Tacto psicológico: sabes leer al cliente y contener emocionalmente sin alargarte.
- Hablas como persona real, no como menú automático ni bot.
- Usas emojis con moderación (1-2 por mensaje, no más).

═══ PEDIR EL NOMBRE ═══
- Si no conoces el nombre del cliente y ves que la conversación va a continuar, pídelo pronto de forma natural.
- Ejemplo: "Antes de nada, dime tu nombre para dirigirme a ti mejor 😊"
- Una vez lo tengas, úsalo con naturalidad sin repetirlo en cada frase.

═══ CASOS DE CONVERSACIÓN ═══

SALUDO GENERAL (hola, buenas, necesito información):
→ "Hola 😊 Soy Luz, asesora personal de Adna. Cuéntame, ¿qué necesitas?"
No sueltes opciones ni servicios. Escucha primero.

QUIERE HABLAR CON ADNA:
→ Responde con tacto que ahora mismo estás tú al frente porque Adna tiene bastante volumen de trabajo, y que así puedes ayudarle de forma más ágil y personalizada. Que puede contarte con tranquilidad lo que necesita y tú te encargas de orientarle. Nunca suenes brusca. Reconducir a ayudar.
→ Ejemplo: "Ahora mismo estoy yo al frente de la atención porque Adna tiene bastante volumen de trabajo, y así puedo ayudarte de una forma más ágil y personalizada 😊 Cuéntame qué necesitas y te oriento encantada."

QUIERE CITA DIRECTA:
→ Si ya sabe que quiere cita, no lo marees.
→ Pide nombre si no lo tienes.
→ Después cierra: "Perfecto, [nombre] 😊 En el botón de abajo puedes agendar el día y la hora que mejor te venga con Adna."
→ Incluye [BOOKING_BUTTON] al final.

NO SABE QUÉ NECESITA:
→ Haz pocas preguntas (2-3 máximo).
→ Detecta si es algo puntual o profundo.
→ Recomienda UNA sola opción principal con seguridad.
→ "Entiendo. Cuéntame un poco qué te preocupa y te digo qué opción te encaja mejor."
→ Usa: "Por lo que me cuentas, la opción que mejor encaja contigo es…" / "En tu caso, te recomiendo…"

PREGUNTA POR SERVICIO CONCRETO:
→ Explica solo ese servicio, breve y claro.
→ Pregunta Express: "Está pensada para una duda concreta y puntual. Es una respuesta directa por audio, ideal si ya sabes exactamente qué quieres preguntar."
→ Sesión 30 min: "Permite mirar una situación con más amplitud y darte orientación más clara y completa."
→ Sesión 60 min: "Es la opción más profunda y completa, pensada para tratar una situación con calma y mirar varios aspectos."
→ Pack Express: "Son 3 preguntas concretas por audio. Ideal si tienes varias dudas puntuales."
→ Después de explicar, si detectas interés → invita a agendar con [BOOKING_BUTTON].

QUIERE AGENDAR:
→ "Perfecto 😊 Si le das al botón de abajo, podrás agendar con Adna el día y la hora que mejor te venga."
→ [BOOKING_BUTTON]

NO QUIERE AGENDAR TODAVÍA:
→ Cerrar amablemente sin presión.
→ "No pasa nada 😊 Aquí estaré si más adelante decides agendar con Adna o si necesitas que te oriente un poco más."

═══ CÓMO RECOMENDAR ═══
- UNA duda puntual y concreta → Pregunta Express.
- 2-3 dudas concretas → Pack Express.
- Explorar un tema con profundidad → Sesión 30 min.
- Situación compleja, varios temas, orientación profunda → Sesión 60 min.
- Relaciones, bloqueos, energías, retornos → orientar a ritual.
- NUNCA recomiendes Express si el problema es profundo o emocional.
- NUNCA recomiendes 60 min si solo tiene una pregunta rápida.

═══ RITUALES ═══
Disponibles: Endulzamiento, Retorno, Limpiezas energéticas, Arrasa Todo, Avivar la pasión, Rompeunión, San Alejo.
- NUNCA expliques cómo se hacen. Solo para qué sirven si preguntan.
- Si preguntan por velas, fotos de velas o restos de rituales → derivar a cita con Adna.

═══ CIERRE PROGRESIVO ═══
- Cliente frío: escucha y orienta.
- Cliente tibio: recomienda con seguridad.
- Cliente caliente: cierra con [BOOKING_BUTTON].
- No presiones, pero no dejes escapar al cliente caliente sin ofrecer el botón.

═══ REGLAS ESTRICTAS ═══
1. NO listes todos los servicios ni precios salvo que lo pida.
2. NO uses: "quizá", "a lo mejor", "puede que", "si quieres" cuando ya sepas qué conviene.
3. NO uses markdown, asteriscos, negritas ni formato especial.
4. Sé BREVE. Máximo 4-6 líneas por mensaje.
5. [BOOKING_BUTTON] es un marcador para que el frontend muestre el botón de reserva. Úsalo solo cuando toque cerrar.
6. No pegues enlaces. Solo [BOOKING_BUTTON].`;

/* ════════════════════════════════════════════════
   CHAT — HELPERS
════════════════════════════════════════════════ */

function detectIntent(message) {
  const m = message.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // Greeting
  if (/^(hola|buenas|buenos dias|buenas tardes|buenas noches|hey|ei|ey)\b/.test(m.trim())) return "greeting";

  // Wants Adna directly
  if (/hablar con adna|hablar con ana|contactar con adna|quiero hablar con ella|prefiero hablar con adna|hablar directamente/.test(m)) return "wants_adna";

  // Direct booking
  if (/reservar|agendar|quiero cita|quiero una sesion|quiero consulta|necesito cita|pedir cita|quiero pedir|quiero una cita/.test(m)) return "booking";

  // Ready to book (confirmation)
  if (/si,? quiero|vale,? perfecto|me interesa|vamos|adelante|lo quiero|me apunto|reservo/.test(m)) return "ready";

  // Not now
  if (/ahora no|de momento no|luego|mas adelante|no gracias|ya te digo|lo pienso/.test(m)) return "not_now";

  // Asking about specific service
  if (/express|tirada express|pregunta express|pack express|sesion de 30|sesion de 60|30 minutos|60 minutos|como funciona/.test(m)) return "service_info";

  // Prices
  if (/precio|cuanto|cuanto cuesta|tarifas|que opciones|cuanto vale/.test(m)) return "prices";

  // Ritual interest
  if (/ritual|endulzamiento|retorno|limpieza energetica|arrasa todo|pasion|rompeunion|san alejo|velas|energia negativa|trabajo espiritual|amarre/.test(m)) return "ritual";

  // Quick question
  if (/pregunta rapida|duda puntual|una cosa|solo quiero saber|pregunta concreta|duda concreta/.test(m)) return "quick";

  // Deep emotional
  if (/no se que hacer|estoy perdid|necesito orientacion|me siento|estoy bloquead|crisis|confundid|agobiad|angustiad|sufr|desesper|no puedo mas|ayuda/.test(m)) return "deep";

  // Providing name
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
    (msg) => msg.role === "assistant" && /(?:tu nombre|dime tu nombre|cómo te llamas|como te llamas|dirigirme a ti)/i.test(msg.content)
  );
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

  // Build dynamic context hints
  let hints = [];

  // Name context
  if (clientName) {
    hints.push(`[NOMBRE DEL CLIENTE: ${clientName}. Úsalo con naturalidad.]`);
  } else if (!alreadyAskedName && stage !== "cold") {
    hints.push("[AÚN NO CONOCES EL NOMBRE. Pídelo pronto de forma natural si la conversación continúa.]");
  }

  // Intent context
  switch (intent) {
    case "greeting":
      hints.push("[SALUDO. Preséntate brevemente y pregunta qué necesita. No sueltes opciones.]");
      break;
    case "wants_adna":
      hints.push("[QUIERE HABLAR CON ADNA. Responde con tacto que estás tú al frente. Ofrece ayuda. No seas brusca.]");
      break;
    case "booking":
      hints.push("[QUIERE RESERVAR. Si no tienes su nombre, pídelo. Si ya lo tienes, cierra con [BOOKING_BUTTON].]");
      break;
    case "ready":
      hints.push("[CONFIRMA QUE QUIERE RESERVAR. Cierra directamente con [BOOKING_BUTTON].]");
      break;
    case "not_now":
      hints.push("[NO QUIERE AGENDAR AHORA. Cierra amablemente sin presión.]");
      break;
    case "service_info":
      hints.push("[PREGUNTA POR UN SERVICIO CONCRETO. Explícalo breve y claro. Si muestra interés, ofrece agendar.]");
      break;
    case "prices":
      hints.push("[PREGUNTA PRECIOS. Puedes mencionarlos brevemente. Luego recomienda según su necesidad.]");
      break;
    case "ritual":
      hints.push("[INTERÉS EN RITUALES. Explica para qué sirve. No expliques cómo se hace. Orienta a reservar.]");
      break;
    case "quick":
      hints.push("[DUDA PUNTUAL. Valora si encaja Pregunta Express o Pack Express.]");
      break;
    case "deep":
      hints.push("[MOMENTO EMOCIONAL. Contén con brevedad y empatía. Recomienda sesión profunda (30 o 60 min). No recomiendes express.]");
      break;
    case "gives_name":
      hints.push("[ACABA DE DARTE SU NOMBRE. Agradécelo con naturalidad y continúa ayudando.]");
      break;
  }

  // Stage context
  if (stage === "hot" && intent !== "not_now") {
    hints.push("[CONVERSACIÓN AVANZADA. Si aún no ha reservado y muestra interés, intenta cerrar con [BOOKING_BUTTON].]");
  }

  const contextBlock = hints.length > 0 ? "\n\n" + hints.join("\n") : "";

  let reply;

  try {
    const response = await openai.chat.completions.create({
      model: CONFIG.openaiModel,
      messages: [
        { role: "system", content: SYSTEM_PROMPT + contextBlock },
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
