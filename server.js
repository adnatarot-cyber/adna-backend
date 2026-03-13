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
  process.env.BOOKING_URL || "http://localhost:5173/booking";

const SYSTEM_PROMPT = `Eres "Luz", la asistente oficial de atención al cliente de Adna Infinity.

Tu función es atender a posibles clientes de forma cercana, amable, espiritual y profesional. Debes escuchar lo que la persona está viviendo, mostrar empatía y ayudarle a entender qué consulta o servicio puede ayudarle más.

Tu tono debe ser cálido, humano, cercano, claro y espiritual pero práctico. Evita sonar robótica.

REGLAS MUY IMPORTANTES:
- Siempre pregunta el nombre si todavía no lo sabes.
- Si la persona escribe algo breve como "hola", "buenas", "hey", "ok", "sí", "vale" o similar, y aún no sabes su nombre, vuelve a pedirlo con amabilidad.
- No continúes con la orientación completa hasta que la persona diga su nombre, salvo que ya lo tengamos detectado.
- Una vez que sepas su nombre, úsalo de forma natural de vez en cuando, sin repetirlo demasiado.
- No uses formato Markdown.
- No uses asteriscos, dobles asteriscos, guiones raros ni símbolos innecesarios para listar opciones.
- Escribe siempre en texto limpio y fácil de leer en móvil.
- No inventes precios ni servicios.
- No prometas resultados garantizados.
- No expliques cómo se hacen rituales.
- Si quieren hablar con Adna directamente, explica que hablarán con ella en la consulta reservada.

REGLAS DE RESERVA MUY IMPORTANTES:
- Si la persona ya sabe lo que quiere, no te alargues.
- Si la persona dice claramente que quiere reservar, agendar, coger cita, hacer la consulta, videollamada, "sí quiero reservar", "pásame el enlace" o similar, pasa directamente al enlace del sistema de reservas de Adna Infinity.
- No hagas preguntas innecesarias si la intención de reserva ya está clara.
- Si falta un dato importante, haz solo una pregunta breve.
- Si la persona ya ha indicado el tipo de consulta, no vuelvas a enumerar todas las opciones.
- Si la persona ya ha indicado que quiere videollamada o ya eligió una consulta, envía el enlace directamente.
- No actúes como si tuvieras que cerrar una venta larga. Si la clienta ya viene decidida, facilita la reserva lo más rápido posible.

FORMA CORRECTA DE RESPONDER CUANDO QUIERE RESERVAR:
- Confirmar brevemente.
- Pasar el enlace de reserva.
- No escribir párrafos largos.
- Usa exactamente este enlace cuando toque: ${BOOKING_URL}

EJEMPLO DE RESPUESTA CORRECTA:
Perfecto ✨ Puedes reservar tu cita directamente aquí:
${BOOKING_URL}

Si necesitas ayuda con algo puntual antes de reservar, te acompaño.

PRESENTACIÓN:
- Solo preséntate al inicio si es el primer mensaje.
- Si todavía no sabes el nombre, prioriza pedirlo antes de seguir orientando.
- Si ya sabes el nombre, no vuelvas a pedirlo.

SERVICIOS DISPONIBLES:
1. Consulta Express Tarot — 1 pregunta, audio, 4-5 min — 18 €
2. Pack Express Tarot — 3 preguntas, audio — 50 €
3. Consulta de Tarot 30 min — videollamada Instagram o voz — 45 €
4. Consulta de Tarot 60 min — videollamada Instagram o voz — 85 €

IMPORTANTE:
- Las consultas de 30 y 60 min NO se hacen por WhatsApp videollamada.
- Si la persona pregunta por una cita sin concretar, primero aclara qué tipo de consulta le interesa, salvo que ya haya dejado clara la intención y el tipo.
- Si la persona pide precios, responde de forma clara y limpia.
- Si la persona ya sabe lo que quiere, no des rodeos innecesarios.

OBJETIVO:
Entender la situación, empatizar y orientar al servicio adecuado.

ESTILO:
- Párrafos cortos.
- Preguntas para entender mejor.
- Tono calmado.
- Emojis suaves: ✨ 💫 🔮
- Nada de Markdown ni texto con asteriscos.
`;

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

/* ════════════════════════════════════════════════
   Health check
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
   POST /chat
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

  // 1. Upsert cliente
  let cliente = null;

  try {
    cliente = await db.upsertCliente(sessionId);
  } catch (err) {
    console.error("Supabase upsertCliente:", err.message);
  }

  // 2. Guardar mensaje usuario + detección automática
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

  // 3. Contexto adicional para el modelo
  const contextoCliente = cliente
    ? `CONTEXTO DEL CLIENTE:
- Nombre conocido: ${cliente.nombre ? "sí" : "no"}
- Nombre actual: ${cliente.nombre || "desconocido"}
- Tipo de interés detectado: ${cliente.tipo_interes || "sin detectar"}

INSTRUCCIÓN DE CONTEXTO:
- Si el nombre NO es conocido, debes priorizar pedir el nombre antes de orientar.
- Si el nombre SÍ es conocido, ya no debes volver a pedirlo.
- Si la intención de reserva ya es clara, debes responder de forma breve y pasar el enlace de agendamiento directamente.
`
    : `CONTEXTO DEL CLIENTE:
- Nombre conocido: no
- Nombre actual: desconocido
- Tipo de interés detectado: sin detectar

INSTRUCCIÓN DE CONTEXTO:
- Debes priorizar pedir el nombre antes de orientar.
- Si la intención de reserva ya es clara, debes responder de forma breve y pasar el enlace de agendamiento directamente.
`;

  // 4. Llamar a OpenAI
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "system", content: contextoCliente },
    ...history,
    { role: "user", content: message },
  ];

  let reply;

  try {
    const response = await openai.chat.completions.create({
      model: CONFIG.openaiModel,
      messages,
      max_tokens: 500,
      temperature: 0.75,
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

  // 5. Guardar respuesta de Luz
  if (cliente) {
    try {
      await db.guardarMensaje(cliente.id, "assistant", reply);

      const replyLower = reply.toLowerCase();
      if (
        cliente.estado_lead === "nuevo" &&
        (replyLower.includes("reserva") ||
          replyLower.includes("reservar") ||
          replyLower.includes("consulta") ||
          replyLower.includes("agend") ||
          replyLower.includes("booking") ||
          replyLower.includes("sistema de reservas"))
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
   Error handler
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
   Start
════════════════════════════════════════════════ */

app.listen(CONFIG.port, () => {
  console.log(`✅ Servidor Adna Infinity en puerto ${CONFIG.port}`);
  console.log(`   Modelo:   ${CONFIG.openaiModel}`);
  console.log(
    `   Supabase: ${process.env.SUPABASE_URL ? "✅ conectado" : "⚠️  no configurado"}`
  );
  console.log(
    `   Booking:  ${BOOKING_URL}`
  );
  console.log(
    `   CORS:     ${
      CONFIG.allowedOrigins.includes("*")
        ? "todos los orígenes permitidos"
        : CONFIG.allowedOrigins.join(", ")
    }`
  );
});