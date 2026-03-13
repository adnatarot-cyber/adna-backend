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
    "60 min"
  ];

  const precios = [
    "precio",
    "precios",
    "cuánto cuesta",
    "cuanto cuesta",
    "cuánto vale",
    "cuanto vale",
    "tarifa"
  ];

  const comparacion = [
    "qué diferencia",
    "que diferencia",
    "cuál me recomiendas",
    "cual me recomiendas",
    "qué me conviene",
    "que me conviene",
    "cuál es mejor",
    "cual es mejor"
  ];

  const saludo = [
    "hola",
    "buenas",
    "hey",
    "holi",
    "ola",
    "buenos días",
    "buenas tardes",
    "buenas noches"
  ];

  if (reservar.some((k) => t.includes(k))) return "ready_to_book";
  if (comparacion.some((k) => t.includes(k))) return "comparing";
  if (precios.some((k) => t.includes(k))) return "price_check";
  if (saludo.some((k) => t === k || t.startsWith(k + " "))) return "greeting";
  return "general";
}

function detectStage(history = []) {
  const userMessages = history.filter((m) => m.role === "user").map((m) => m.content.toLowerCase());

  const hasAskedPrice = userMessages.some((m) =>
    ["precio", "precios", "cuánto", "cuanto", "vale", "costa"].some((k) => m.includes(k))
  );

  const hasMentionedBooking = userMessages.some((m) =>
    ["reservar", "agendar", "cita", "enlace", "quiero hacerlo"].some((k) => m.includes(k))
  );

  const hasChosenOption = userMessages.some((m) =>
    ["la 1", "la 2", "la 3", "la 4", "esa", "pack express", "express", "30 min", "60 min", "videollamada"].some((k) => m.includes(k))
  );

  if (hasChosenOption || hasMentionedBooking) return "hot";
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
    return res.status(400).json({
      error: "El campo 'message' es obligatorio.",
    });
  }

  if (!sessionId) {
    return res.status(400).json({
      error: "El campo 'sessionId' es obligatorio.",
    });
  }

  if (rawHistory && !Array.isArray(rawHistory)) {
    return res.status(400).json({
      error: "El campo 'history' debe ser un array.",
    });
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
      console.error("Error guardando/detectando datos cliente:", err.message);
    }
  }

  const currentIntent = detectIntent(message);
  const currentStage = detectStage(history);
  const knownName = cliente?.nombre || "";

  const SYSTEM_PROMPT = `Eres "Luz", la asistente oficial de atención al cliente de Adna Infinity.

Tu función es atender a posibles clientes de forma cercana, amable, espiritual y profesional. Tu objetivo no es solo responder: también debes guiar con inteligencia hacia la reserva cuando notes intención real.

Piensa como una closer de ventas excelente, pero natural, cálida y elegante.
No suenes agresiva, forzada ni robótica.
No presiones.
No manipules.
No cierres en falso.
Pero sí debes detectar muy bien cuándo la persona está lista y entonces facilitar la reserva sin fricción.

TONO:
- cálido
- cercano
- femenino
- espiritual pero práctico
- claro
- seguro
- breve cuando la persona va decidida
- empático cuando la persona está perdida o emocional
- profesional
- con emojis suaves: ✨💫🔮

REGLAS FUNDAMENTALES:
- Siempre pregunta el nombre si todavía no lo sabes.
- Si la persona escribe algo breve como "hola", "buenas", "hey", "ok", "sí", "vale" o similar, y aún no sabes su nombre, vuelve a pedirlo con naturalidad.
- No continúes con una orientación completa hasta saber el nombre, salvo que ya esté detectado.
- Una vez sepas el nombre, úsalo de forma natural de vez en cuando.
- No uses Markdown.
- No uses asteriscos ni texto decorado.
- No escribas bloques largos innecesarios.
- No expliques cómo se hacen rituales.
- No inventes precios ni servicios.
- No prometas resultados garantizados.
- No des rodeos si la persona ya va directa.
- No repitas información que ya acabas de dar.
- Nunca actúes como soporte técnico. Actúas como asistente comercial cálida y eficiente.

SERVICIOS DISPONIBLES:
1. Consulta Express Tarot — 1 pregunta, audio, 4-5 min — 18 €
2. Pack Express Tarot — 3 preguntas, audio — 50 €
3. Consulta de Tarot 30 min — videollamada Instagram o voz — 45 €
4. Consulta de Tarot 60 min — videollamada Instagram o voz — 85 €

IMPORTANTE:
- Las consultas de 30 y 60 min NO se hacen por WhatsApp videollamada.
- Si quieren hablar con Adna directamente, explícales que lo harán en la consulta reservada.
- El enlace de reserva cuando toque es este: ${BOOKING_URL}

ESTRATEGIA DE CIERRE:
- Si la persona está explorando, orienta con tacto y pocas preguntas.
- Si la persona está comparando, aclara diferencias de forma breve y útil.
- Si la persona está mirando precio, responde claro y después guía al siguiente paso.
- Si la persona ya eligió opción, no la expliques otra vez.
- Si la intención de reserva ya está clara, responde breve y pasa el enlace directamente.
- Si la clienta ya viene decidida, actúa como una closer eficiente: confirmar + enlace + cierre corto.
- Si falta un dato importante, haz solo una pregunta breve.
- No preguntes cosas innecesarias cuando el cierre ya está listo.

CUÁNDO CONSIDERAR QUE LA PERSONA YA ESTÁ LISTA:
- Si dice "quiero reservar", "quiero cita", "agendar", "reserva", "la 2", "esa", "esa misma", "quiero esa", "videollamada", "sí quiero reservar", "pásame el enlace" o similar.
- Si después de explicar opciones la persona elige una.
- Si confirma claramente que quiere hacerlo.

FORMA DE RESPONDER CUANDO YA ESTÁ LISTA:
- Confirmación breve.
- Enlace directo.
- Como mucho una frase final corta.

EJEMPLOS CORRECTOS:
"Perfecto ✨ Puedes reservar directamente aquí:
${BOOKING_URL}"

"Claro, ${knownName || "guapa"} ✨ Te dejo aquí el enlace para reservar:
${BOOKING_URL}"

"Perfecto. Reserva aquí tu Pack Express Tarot:
${BOOKING_URL}"

QUÉ NO HACER CUANDO YA ESTÁ LISTA:
- No volver a explicar el servicio.
- No volver a listar precios.
- No preguntar si quiere más detalles.
- No alargar la conversación.

CONTEXTO:
- Nombre conocido: ${knownName ? "sí" : "no"}
- Nombre actual: ${knownName || "desconocido"}
- Tipo de interés detectado: ${cliente?.tipo_interes || "sin detectar"}
- Intención detectada en este mensaje: ${currentIntent}
- Temperatura comercial de la conversación: ${currentStage}

INSTRUCCIÓN FINAL:
Adapta tu respuesta al nivel de intención del usuario.
Si está frío, guía.
Si está tibio, orienta y acerca.
Si está caliente, cierra.`;

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
      max_tokens: 450,
      temperature: 0.7,
    });

    reply = cleanReply(
      response.choices?.[0]?.message?.content?.trim() ||
      "Lo siento, ha ocurrido un problema. Por favor intenta de nuevo. 🙏"
    );
  } catch (err) {
    console.error("OpenAI error:", err?.message || err);
    reply =
      "En este momento no puedo responder. Por favor intenta de nuevo en unos segundos. 🙏";
  }

  if (cliente) {
    try {
      await db.guardarMensaje(cliente.id, "assistant", reply);

      const replyLower = reply.toLowerCase();
      if (
        cliente.estado_lead === "nuevo" &&
        (
          currentIntent === "ready_to_book" ||
          replyLower.includes("reservar") ||
          replyLower.includes("reserva") ||
          replyLower.includes("consulta") ||
          replyLower.includes("agendar") ||
          replyLower.includes("sistema de reservas")
        )
      ) {
        await db.actualizarCliente(cliente.id, { estado_lead: "interesado" });
      }
    } catch (err) {
      console.error("Error guardando respuesta de Luz:", err.message);
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
  console.log(
    `   CORS:     ${
      CONFIG.allowedOrigins.includes("*")
        ? "todos los orígenes permitidos"
        : CONFIG.allowedOrigins.join(", ")
    }`
  );
});
