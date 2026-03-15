// ════════════════════════════════════════════════
// ADNA INFINITY — Servicio de base de datos
// backend/db.js
// ════════════════════════════════════════════════

const { createClient } = require("@supabase/supabase-js");

// ── Cliente Supabase (singleton) ──────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY  // service_role key — nunca la expongas en frontend
);

// ════════════════════════════════════════════════
// CLIENTES
// ════════════════════════════════════════════════

/**
 * Obtiene un cliente por session_id.
 * Si no existe, lo crea con estado "nuevo".
 * Si existe, actualiza fecha_ultima_conversacion.
 * @param {string} sessionId
 * @returns {Object} cliente
 */
async function upsertCliente(sessionId) {
  // Buscar cliente existente
  const { data: existing, error: findError } = await supabase
    .from("clientes")
    .select("*")
    .eq("session_id", sessionId)
    .maybeSingle();

  if (findError) throw new Error("Error buscando cliente: " + findError.message);

  if (existing) {
    // Actualizar última conversación
    const { data, error } = await supabase
      .from("clientes")
      .update({ fecha_ultima_conversacion: new Date().toISOString() })
      .eq("id", existing.id)
      .select()
      .single();

    if (error) throw new Error("Error actualizando cliente: " + error.message);
    return data;
  }

  // Crear nuevo cliente
  const { data, error } = await supabase
    .from("clientes")
    .insert({
      session_id:             sessionId,
      canal_origen:           "chatbot_web",
      estado_lead:            "nuevo",
      fecha_primer_contacto:  new Date().toISOString(),
      fecha_ultima_conversacion: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) throw new Error("Error creando cliente: " + error.message);
  return data;
}

/**
 * Actualiza campos del cliente (nombre, tipo_interes, estado_lead, resumen).
 * Solo actualiza los campos que se pasen (los demás quedan igual).
 * @param {string} clienteId  UUID del cliente
 * @param {Object} campos     { nombre?, tipo_interes?, estado_lead?, resumen? }
 */
async function actualizarCliente(clienteId, campos) {
  const { error } = await supabase
    .from("clientes")
    .update(campos)
    .eq("id", clienteId);

  if (error) console.error("Error actualizando cliente:", error.message);
}

// ════════════════════════════════════════════════
// MENSAJES
// ════════════════════════════════════════════════

/**
 * Guarda un mensaje en la tabla mensajes.
 * @param {string} clienteId  UUID del cliente
 * @param {string} role       "user" | "assistant"
 * @param {string} content    Texto del mensaje
 */
async function guardarMensaje(clienteId, role, content) {
  const { error } = await supabase
    .from("mensajes")
    .insert({ cliente_id: clienteId, role, content });

  if (error) console.error("Error guardando mensaje:", error.message);
}

/**
 * Devuelve todos los mensajes de un cliente ordenados por fecha.
 * @param {string} clienteId
 * @returns {Array}
 */
async function getMensajesCliente(clienteId) {
  const { data, error } = await supabase
    .from("mensajes")
    .select("role, content, created_at")
    .eq("cliente_id", clienteId)
    .order("created_at", { ascending: true });

  if (error) throw new Error("Error obteniendo mensajes: " + error.message);
  return data || [];
}

// ════════════════════════════════════════════════
// DETECCIÓN AUTOMÁTICA DE DATOS
// ════════════════════════════════════════════════

/**
 * Intenta detectar el nombre del cliente en su mensaje.
 * Muy simple: busca patrones como "me llamo X", "soy X", "mi nombre es X".
 * @param {string} texto
 * @returns {string|null}
 */
function detectarNombre(texto) {
  const patrones = [
    /(?:me llamo|soy|mi nombre es)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/i,
    /^([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+),?\s+(?:tengo|quiero|necesito)/i,
  ];
  for (const p of patrones) {
    const m = texto.match(p);
    if (m && m[1]) return m[1];
  }
  return null;
}

/**
 * Intenta detectar el tipo de interés del cliente según sus palabras.
 * @param {string} texto
 * @returns {string|null}
 */
function detectarTipoInteres(texto) {
  const t = texto.toLowerCase();
  if (t.includes("60") || t.includes("hora") || t.includes("profund"))    return "60min";
  if (t.includes("30") || t.includes("media hora") || t.includes("completa")) return "30min";
  if (t.includes("pack") || t.includes("3 preguntas") || t.includes("tres")) return "pack_express";
  if (t.includes("express") || t.includes("rápid") || t.includes("una pregunta")) return "express";
  return null;
}

module.exports = {
  supabase,
  upsertCliente,
  actualizarCliente,
  guardarMensaje,
  getMensajesCliente,
  detectarNombre,
  detectarTipoInteres,
};
