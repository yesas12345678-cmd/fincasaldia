// server.js
// Servidor Express para servir la aplicación estática y gestionar la API de sincronización PostgreSQL en Dokploy/VPS

const express = require('express');
const { Client } = require('pg');
const path = require('path');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

const connectionString = 'postgresql://postgres:vd1tmp242irvcww1@187.127.233.89:5438/postgres';

app.use(cors());
app.use(express.text({ limit: '10mb' }));
app.use(express.json());

// Servir archivos estáticos en la raíz
app.use(express.static(path.join(__dirname)));

// Endpoint unificado para sincronización
app.use('/api/sync', async (req, res) => {
  const code = req.query.code;
  const action = req.query.action;
  
  const client = new Client({
    connectionString,
    ssl: false
  });

  try {
    await client.connect();
    
    // Asegurar existencia de la tabla
    await client.query(`
      CREATE TABLE IF NOT EXISTS sync_groups (
        code VARCHAR(50) PRIMARY KEY,
        data JSONB NOT NULL,
        last_updated BIGINT NOT NULL DEFAULT 0
      );
    `);

    // 1. LISTAR CUENTAS (Para el administrador)
    if (action === 'list') {
      const password = req.query.password;
      if (password !== 'Manuel1214$') {
        return res.status(403).json({ error: "Unauthorized" });
      }
      const dbRes = await client.query('SELECT code, last_updated FROM sync_groups ORDER BY code ASC');
      return res.json(dbRes.rows);
    }

    // ELIMINAR CUENTA COMPLETA (Solo administrador)
    if (action === 'delete') {
      const adminPass = req.query.admin_password;
      if (adminPass !== 'Manuel1214$') {
        return res.status(403).json({ error: "Unauthorized" });
      }
      if (!code) {
        return res.status(400).json({ error: "Missing code parameter" });
      }
      await client.query('DELETE FROM sync_groups WHERE code = $1', [code]);
      return res.json({ success: true });
    }

    // 2. CREACIÓN DE GRUPO NUEVO (POST con action=create)
    if (action === 'create') {
      const adminPass = req.query.admin_password;
      if (adminPass !== 'Manuel1214$') {
        return res.status(403).json({ error: "Unauthorized" });
      }
      
      const newCode = req.query.new_code.trim().toLowerCase();
      const newPassword = req.query.new_password;
      
      const check = await client.query('SELECT 1 FROM sync_groups WHERE code = $1', [newCode]);
      if (check.rows.length > 0) {
        return res.status(409).json({ error: "Account already exists" });
      }

      const payload = JSON.parse(req.body);
      payload.password = newPassword;
      payload.syncCode = newCode;
      
      const lastUpdated = Date.now();
      await client.query(
        'INSERT INTO sync_groups (code, data, last_updated) VALUES ($1, $2, $3)',
        [newCode, JSON.stringify(payload), lastUpdated]
      );

      return res.json({ success: true, code: newCode });
    }

    if (!code) {
      return res.status(400).json({ error: "Missing code parameter" });
    }

    // Obtener datos existentes para verificación de seguridad
    const dbRes = await client.query('SELECT data FROM sync_groups WHERE code = $1', [code]);
    if (dbRes.rows.length === 0) {
      return res.status(404).json({ error: "Group not found" });
    }

    const groupData = dbRes.rows[0].data;
    const clientPassword = req.query.password;
    const adminPassword = req.query.admin_password;

    // Validar contraseña
    const isAuthorized = (clientPassword && clientPassword === groupData.password) || 
                         (adminPassword && adminPassword === 'Manuel1214$');

    if (!isAuthorized) {
      return res.status(401).json({ error: "Incorrect user password" });
    }

    // 3. OBTENER DATOS (GET con código)
    if (req.method === "GET") {
      return res.json(groupData);
    }

    // 4. ACTUALIZAR DATOS (POST con código)
    if (req.method === "POST") {
      const payload = JSON.parse(req.body);
      
      // Mantener la contraseña
      if (!payload.password) {
        payload.password = groupData.password;
      }
      
      const lastUpdated = payload.lastUpdated || Date.now();
      
      await client.query(`
        INSERT INTO sync_groups (code, data, last_updated)
        VALUES ($1, $2, $3)
        ON CONFLICT (code)
        DO UPDATE SET data = EXCLUDED.data, last_updated = EXCLUDED.last_updated
      `, [code, JSON.stringify(payload), lastUpdated]);

      return res.json({ success: true });
    }

    return res.status(405).send("Method Not Allowed");

  } catch (err) {
    console.error("Database error in express server:", err);
    return res.status(500).json({ error: err.message });
  } finally {
    await client.end();
  }
});

// Extraer notas o descripción adicional descartando lo que ya se mapeó a Tipo y Materiales
function extractDescription(fullText, tipo, materiales) {
  let temp = fullText.toLowerCase();
  
  // 1. Quitar frases introductorias y de acción
  const triggersToRemove = [
    "quiero reportar una incidencia",
    "quiero reportar un incidente",
    "reportar una incidencia",
    "reportar un incidente",
    "quiero reportar una averia",
    "quiero reportar una avería",
    "reportar una averia",
    "reportar una avería",
    "incidencia de",
    "incidencia",
    "averia de",
    "avería de",
    "averia",
    "avería"
  ];
  
  for (const trigger of triggersToRemove) {
    temp = temp.replace(trigger, "");
  }
  
  // 2. Quitar ubicación
  const gpsKeywords = [
    "donde estoy",
    "dónde estoy",
    "en esta posición",
    "en esta posicion",
    "mi posicion",
    "mi posición",
    "ubicación actual",
    "ubicacion actual",
    "aquí",
    "aqui"
  ];
  
  for (const keyword of gpsKeywords) {
    temp = temp.replace(keyword, "");
  }
  
  // 3. Quitar frase de "hay un / tengo un"
  temp = temp.replace(/\b(?:hay un|hay una|tengo un|tengo una|se ha detectado un|se ha detectado una|detectado un|detectada una|veo un|veo una)\b/gi, "");
  
  // 4. Quitar los materiales y la frase "necesito X"
  if (materiales) {
    const regexMateriales = new RegExp(`(?:necesito|necesitamos|hace falta|hacen falta|hace falta comprar|comprar)?\\s*(?:un\\s+|una\\s+|unos\\s+|unas\\s+|el\\s+|la\\s+|los\\s+|las\\s+)?${materiales.toLowerCase()}`, "gi");
    temp = temp.replace(regexMateriales, "");
  }
  
  // 5. Quitar el tipo de incidencia
  if (tipo) {
    const regexTipo = new RegExp(`(?:un\\s+|una\\s+|unos\\s+|unas\\s+|el\\s+|la\\s+|los\\s+|las\\s+)?${tipo.toLowerCase()}`, "gi");
    temp = temp.replace(regexTipo, "");
  }
  
  // 6. Limpieza final de espacios y palabras conectoras al inicio/final
  let cleanDesc = temp.trim();
  
  cleanDesc = cleanDesc.replace(/^(?:de|en|y|con|donde|para|que|esta|este|la|el|los|las|un|una)\s+/gi, "");
  cleanDesc = cleanDesc.trim();
  
  if (cleanDesc.length <= 2) {
    return "";
  }
  
  return cleanDesc.charAt(0).toUpperCase() + cleanDesc.slice(1);
}

// Limpiar descripciones compuestas únicamente de palabras de relleno
function cleanDescriptionOfFillerWords(desc) {
  if (!desc) return "";
  
  const stopWords = new Set([
    "quiero", "registra", "registrar", "registro", "registré", "registre", "reportar", "reporta", "reporto", "reporté", "reporte", 
    "incidencia", "incidente", "averia", "avería", "problema", "nuevo", "nuevos", "nueva", "nuevas",
    "finca", "del", "de", "la", "el", "los", "las", "un", "una", "unos", "unas", 
    "y", "que", "en", "por", "con", "donde", "esta", "este", "estos", "estas", 
    "cual", "la cual", "lo", "los", "las", "para", "aqui", "aquí", "estoy", 
    "dónde", "donde", "tengo", "hay", "se", "ha", "me", "te", "le", "nos", "veo", "detectado", "detectada", 
    "necesito", "necesitamos", "hace", "falta", "hacen", "traer", "traiga", 
    "tráeme", "traeme", "añadir", "añadas", "añade", "pon", "poner", "puso", "puse", "lista", "compra", "comprar",
    "mi", "mis", "tu", "tus", "su", "sus", "como", "este", "esta", "esto", "a", "al", "o"
  ]);
  
  const words = desc.toLowerCase().match(/[a-zñáéíóúü]+/gi) || [];
  if (words.length === 0) return "";
  
  const nonStopWords = words.filter(word => !stopWords.has(word));
  
  if (nonStopWords.length === 0 || (nonStopWords.length / words.length) < 0.3) {
    return "";
  }
  
  return desc;
}

// Extraer artículos de la lista de la compra descartando frases introductorias o finales
function extractShoppingItems(fullText) {
  let temp = fullText.trim();
  
  // 1. Quitar frases explicativas del inicio
  const leadingPhrases = [
    /^(?:quiero\s+)?comprar\s+/gi,
    /^(?:quiero\s+)?añadir\s+a\s+la\s+lista\s+de\s+la\s+compra\s+/gi,
    /^(?:quiero\s+)?añadir\s+a\s+la\s+lista\s+de\s+compra\s+/gi,
    /^(?:quiero\s+)?añadir\s+a\s+la\s+lista\s+/gi,
    /^(?:tengo\s+que|hay\s+que|necesito|necesitamos)\s+comprar\s+/gi,
    /^(?:tengo\s+que|hay\s+que|necesito|necesitamos)\s+añadir\s+/gi,
    /^añade\s+/gi,
    /^añadir\s+/gi,
    /^pon\s+/gi,
    /^poner\s+/gi
  ];
  
  for (const regex of leadingPhrases) {
    temp = temp.replace(regex, "");
  }
  
  // 2. Quitar frases explicativas del final
  const trailingPhrases = [
    /\s+a\s+la\s+lista\s+de\s+la\s+compra$/gi,
    /\s+a\s+la\s+lista\s+de\s+compra$/gi,
    /\s+en\s+la\s+lista\s+de\s+la\s+compra$/gi,
    /\s+en\s+la\s+lista\s+de\s+compra$/gi,
    /\s+a\s+la\s+lista$/gi,
    /\s+en\s+la\s+lista$/gi,
    /\s+para\s+comprar$/gi,
    /\s+para\s+la\s+compra$/gi
  ];
  
  for (const regex of trailingPhrases) {
    temp = temp.replace(regex, "");
  }
  
  // 3. Separar por " y " o por comas
  const rawItems = temp.split(/\s+y\s+|,/i);
  const items = [];
  
  rawItems.forEach(it => {
    let cleaned = it.trim();
    cleaned = cleaned.replace(/^(?:un|una|unos|unas|el|la|los|las|de)\s+/gi, "");
    cleaned = cleaned.trim();
    if (cleaned.length > 1) {
      cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
      items.push(cleaned);
    }
  });
  
  return items;
}

// Endpoint para procesar comandos de voz desde Atajos de iOS (iPhone / Apple Watch)
// Función para procesar y extraer de forma inteligente todos los campos de una incidencia
function parseIncidentVoiceCommand(cleanText, fincaList, lastGpsPosition, selectedFincaId) {
  let lowerText = cleanText.toLowerCase();
  
  // 1. Corregir transcripciones erróneas acústicas comunes en español rural:
  lowerText = lowerText.replace(/\bse\s+hace\s+con\s+(olivo|almendro|árbol|arbol|parra|planta)/gi, "se ha secado $1");
  lowerText = lowerText.replace(/\bse\s+hace\s+con\s+(olivos|almendros|árboles|arboles|parras|plantas)/gi, "se ha secado $1");
  lowerText = lowerText.replace(/\bse\s+hace\s+(olivo|almendro|árbol|arbol|parra|planta)/gi, "se ha secado $1");
  lowerText = lowerText.replace(/\bse\s+hace\s+(olivos|almendros|árboles|arboles|parras|plantas)/gi, "se ha secado $1");
  
  // 2. DETECTAR FINCA
  let fincaId = selectedFincaId || (fincaList && fincaList[0] ? fincaList[0].id : 'general');
  let matchedFincaName = "";
  if (fincaList && fincaList.length > 0) {
    for (const finca of fincaList) {
      if (finca.name && lowerText.includes(finca.name.toLowerCase())) {
        fincaId = finca.id;
        matchedFincaName = finca.name;
        break;
      }
    }
  }
  
  // 3. DETECTAR SI ES LOCALIZADA (GPS) O GENERAL
  let isGeneral = true;
  const gpsKeywords = ["donde estoy", "dónde estoy", "aqui", "aquí", "ubicacion actual", "ubicación actual", "mi posicion", "mi posición", "gps"];
  if (gpsKeywords.some(keyword => lowerText.includes(keyword))) {
    isGeneral = false;
  }
  
  // 4. EXTRACT MATERIALES (necesito X, comprar X, traer X...)
  let materiales = '';
  const necesitoRegex = /(?:necesito|necesitamos|hace falta|hacen falta|hace falta comprar|comprar|traer|traiga|tráeme|traeme|añadas|añadir)\s+(?:que\s+)?(?:me\s+)?(?:des\s+)?(?:traiga\s+|traigas\s+|traer\s+|tráeme\s+|traeme\s+)?(?:un\s+|una\s+|unos\s+|unas\s+|el\s+|la\s+|los\s+|las\s+)?([^,.]+)/i;
  const necesitoMatch = lowerText.match(necesitoRegex);
  let matchedMaterialString = "";
  if (necesitoMatch && necesitoMatch[1]) {
    materiales = necesitoMatch[1].trim();
    matchedMaterialString = necesitoMatch[0];
    materiales = materiales.replace(/^(un|una|unos|unas|el|la|los|las|algun|algunos|algunas|de)\s+/i, '');
    materiales = materiales.charAt(0).toUpperCase() + materiales.slice(1);
  }
  
  // 5. EXTRACT TIPO DE INCIDENCIA (PROBLEMA)
  let tipo = '';
  let matchedVerbString = "";
  
  // A. Buscar si se ha roto/secado/dañado algo con verbo antes (ej: "se me ha roto un almendro")
  const verbBeforeRegex = /\b(?:se\s+ha\s+roto|se\s+me\s+ha\s+roto|se\s+rompió|se\s+rompio|se\s+ha\s+dañado|se\s+me\s+ha\s+dañado|se\s+dañó|se\s+danó|se\s+ha\s+estropeado|se\s+me\s+ha\s+estropeado|se\s+estropeó|se\s+estropeo|se\s+ha\s+secado|se\s+me\s+ha\s+secado|se\s+secó|se\s+seco)\s+(?:un\s+|una\s+|el\s+|la\s+|los\s+|las\s+|unos\s+|unas\s+)?(olivo|almendro|goma|tubo|válvula|valvula|llave|manguera|gotero|aspersor|árbol|arbol|parra|planta|muro|valla|cable|bomba|motor)\b/i;
  const verbBeforeMatch = lowerText.match(verbBeforeRegex);
  if (verbBeforeMatch && verbBeforeMatch[1]) {
    const noun = verbBeforeMatch[1];
    matchedVerbString = verbBeforeMatch[0];
    const matchStr = verbBeforeMatch[0].toLowerCase();
    let verbType = "roto";
    if (matchStr.includes("secado") || matchStr.includes("secó") || matchStr.includes("seco")) {
      verbType = "seco";
    } else if (matchStr.includes("dañado") || matchStr.includes("dañó") || matchStr.includes("danó")) {
      verbType = "dañado";
    }
    
    const femNouns = ["goma", "válvula", "valvula", "llave", "manguera", "parra", "planta", "valla", "bomba"];
    const isFem = femNouns.includes(noun.toLowerCase());
    let adj = "roto";
    if (verbType === "seco") adj = isFem ? "seca" : "seco";
    else if (verbType === "dañado") adj = isFem ? "dañada" : "dañado";
    else adj = isFem ? "rota" : "roto";
    
    tipo = noun.charAt(0).toUpperCase() + noun.slice(1).toLowerCase() + " " + adj;
  }
  
  // B. Buscar si se ha secado algo
  if (!tipo) {
    const secadoRegex = /\b(?:se\s+ha\s+secado|se\s+secó|se\s+seco|se\s+ha\s+seco)\s+(?:un\s+|una\s+|el\s+|la\s+)?(olivo|almendro|árbol|arbol|parra|planta|olivos|almendros|árboles|arboles|parras|plantas)\b/i;
    const secadoMatch = lowerText.match(secadoRegex);
    if (secadoMatch && secadoMatch[1]) {
      const noun = secadoMatch[1];
      if (noun.startsWith("almendro")) tipo = "Almendro seco";
      else if (noun.startsWith("olivo")) tipo = "Olivo seco";
      else if (noun.startsWith("árbol") || noun.startsWith("arbol")) tipo = "Árbol seco";
      else if (noun.startsWith("parra")) tipo = "Parra seca";
      else if (noun.startsWith("planta")) tipo = "Planta seca";
    }
  }
  
  // B. Buscar patrón: sustantivo + adjetivo de rotura/daño
  if (!tipo) {
    const adjRegex = /\b(olivo|almendro|goma|tubo|válvula|valvula|llave|manguera|gotero|aspersor|árbol|arbol|parra|planta|muro|valla|cable|bomba|motor)\s+(roto|rota|dañado|dañada|seco|seca|enfermo|enferma|bloqueado|bloqueada|fuga|perdida|perdiendo|secado|secada)\b/i;
    const adjMatch = lowerText.match(adjRegex);
    if (adjMatch) {
      const noun = adjMatch[1].charAt(0).toUpperCase() + adjMatch[1].slice(1).toLowerCase();
      const adj = adjMatch[2].toLowerCase();
      tipo = `${noun} ${adj}`;
    }
  }
  
  // C. Buscar "hay un X roto", "tengo una X rota"
  if (!tipo) {
    const hayRegex = /(?:hay|tengo|se ha detectado|detectado|veo)\s+(?:un\s+|una\s+)?([^,.]+?(?:roto|rota|enfermo|enferma|dañado|dañada|fuga|perdida|perdiendo|seco|seca))/i;
    const hayMatch = lowerText.match(hayRegex);
    if (hayMatch && hayMatch[1]) {
      let t = hayMatch[1].trim();
      t = t.replace(/^(un|una|unos|unas|el|la|los|las|de)\s+/i, '');
      tipo = t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
    }
  }
  
  // D. Mapeo implícito a partir de los materiales (si no se detectó tipo pero sí material)
  if (!tipo && materiales) {
    const matLower = materiales.toLowerCase();
    if (matLower.includes("almendro")) tipo = "Almendro seco";
    else if (matLower.includes("olivo")) tipo = "Olivo seco";
    else if (matLower.includes("goma")) tipo = "Goma rota";
    else if (matLower.includes("tubo")) tipo = "Tubo roto";
    else if (matLower.includes("válvula") || matLower.includes("valvula")) tipo = "Válvula rota";
    else if (matLower.includes("gotero")) tipo = "Gotero taponado";
    else if (matLower.includes("pala") || matLower.includes("herramienta")) tipo = "Incidencia de campo";
  }
  
  // E. Fallback por palabras clave
  if (!tipo) {
    if (lowerText.includes("goma rota") || lowerText.includes("gomas rotas")) tipo = "Goma rota";
    else if (lowerText.includes("olivo seco") || lowerText.includes("olivos secos")) tipo = "Olivo seco";
    else if (lowerText.includes("almendro seco") || lowerText.includes("almendros secos")) tipo = "Almendro seco";
    else if (lowerText.includes("fuga de agua") || lowerText.includes("fuga")) tipo = "Fuga de agua";
    else if (lowerText.includes("tubo roto") || lowerText.includes("tubo dañado")) tipo = "Tubo roto";
  }
  
  // F. Fallback por estructura
  if (!tipo) {
    const startMatch = lowerText.match(/(?:incidencia|averia|avería|reportar)\s+(?:donde estoy\s+)?(?:hay\s+)?([^,.]+?)(?:\s+(?:necesito|para|donde|en|de)\b|$)/i);
    if (startMatch && startMatch[1]) {
      let t = startMatch[1].trim();
      t = t.replace(/^(?:de la finca del|de la finca de|de la finca|finca del|finca de|finca)\s+[^,.]+/gi, "").trim();
      t = t.replace(/^(?:el|la|los|las|un|una|de|en|por)\s+/gi, "").trim();
      if (t.length > 2) {
        tipo = t.charAt(0).toUpperCase() + t.slice(1);
      }
    }
  }
  
  if (!tipo) {
    tipo = "Incidencia de Voz";
  }
  
  // 6. EXTRACT DESCRIPCIÓN (descartando lo mapeado)
  let tempDesc = lowerText;
  if (matchedMaterialString) {
    tempDesc = tempDesc.replace(matchedMaterialString.toLowerCase(), "");
  }
  if (matchedVerbString) {
    tempDesc = tempDesc.replace(matchedVerbString.toLowerCase(), "");
  }
  if (tipo) {
    tempDesc = tempDesc.replace(tipo.toLowerCase(), "");
    tempDesc = tempDesc.replace("se ha secado", "");
    tempDesc = tempDesc.replace("se hace con", "");
  }
  if (matchedFincaName) {
    tempDesc = tempDesc.replace(matchedFincaName.toLowerCase(), "");
    tempDesc = tempDesc.replace("finca del", "");
    tempDesc = tempDesc.replace("finca de", "");
    tempDesc = tempDesc.replace("finca", "");
  }
  
  const triggersToRemove = [
    "quiero reportar una incidencia",
    "quiero reportar un incidente",
    "reportar una incidencia",
    "reportar un incidente",
    "quiero reportar una averia",
    "quiero reportar una avería",
    "reportar una averia",
    "reportar una avería",
    "incidencia de",
    "incidencia",
    "averia de",
    "avería de",
    "averia",
    "avería",
    "donde estoy",
    "dónde estoy",
    "en esta posición",
    "en esta posicion",
    "mi posicion",
    "mi posición",
    "ubicación actual",
    "ubicacion actual",
    "aquí",
    "aqui",
    "en la",
    "en el",
    "registro en",
    "registro"
  ];
  for (const trigger of triggersToRemove) {
    tempDesc = tempDesc.replace(trigger, "");
  }
  
  tempDesc = tempDesc.replace(/\b(?:hay un|hay una|tengo un|tengo una|se ha detectado un|se ha detectado una|detectado un|detectada una|veo un|veo una)\b/gi, "");
  
  let cleanDesc = tempDesc.trim();
  cleanDesc = cleanDesc.replace(/^(?:de|en|y|con|donde|para|que|esta|este|la|el|los|las|un|una|por una|por un)\s+/gi, "");
  cleanDesc = cleanDesc.trim();
  
  cleanDesc = cleanDescriptionOfFillerWords(cleanDesc);
  
  if (cleanDesc.length <= 2) {
    cleanDesc = "";
  } else {
    cleanDesc = cleanDesc.charAt(0).toUpperCase() + cleanDesc.slice(1);
  }
  
  return {
    fincaId,
    tipo,
    descripcion: cleanDesc,
    materiales,
    isGeneral
  };
}

// Endpoint para procesar comandos de voz desde Atajos de iOS (iPhone / Apple Watch)
app.post('/api/voice-command', async (req, res) => {
  const code = req.query.code;
  const password = req.query.password;
  
  if (!code || !password) {
    return res.status(400).json({ error: "Missing code or password parameter" });
  }
  
  let bodyData;
  if (req.body && typeof req.body === 'object') {
    bodyData = req.body;
  } else {
    try {
      bodyData = JSON.parse(req.body || '{}');
    } catch (e) {
      return res.status(400).json({ error: "Invalid JSON body" });
    }
  }
  
  const text = bodyData.text;
  const lat = bodyData.lat;
  const lng = bodyData.lng;
  
  if (!text) {
    return res.status(400).json({ error: "Missing dictation text" });
  }

  const client = new Client({
    connectionString,
    ssl: false
  });

  try {
    await client.connect();
    
    // Obtener datos del grupo
    const dbRes = await client.query('SELECT data FROM sync_groups WHERE code = $1', [code]);
    if (dbRes.rows.length === 0) {
      return res.status(404).json({ error: "Group not found" });
    }
    
    const groupData = dbRes.rows[0].data;
    if (groupData.password !== password) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    let cleanText = text.trim();
    let lowerText = cleanText.toLowerCase();
    
    // A. EXTRAER COMPRA ANIDADA (si la hay)
    const nestedShoppingRegex = /(?:\by\s+)?(?:añade|añadir|pon|poner|comprar)\s+(?:a\s+la\s+lista\s+de\s+(?:la\s+)?compra|en\s+la\s+lista|a\s+la\s+lista)\s+([^,.]+)/i;
    const nestedShoppingMatch = cleanText.match(nestedShoppingRegex);
    let nestedShoppingItem = "";
    if (nestedShoppingMatch) {
      nestedShoppingItem = nestedShoppingMatch[1].trim();
      if (!groupData.shoppingList) groupData.shoppingList = [];
      const parsedItems = extractShoppingItems(nestedShoppingItem);
      parsedItems.forEach((itemText, idx) => {
        groupData.shoppingList.push({
          id: 'compra-' + Date.now() + '-' + idx,
          text: itemText,
          checked: false
        });
      });
      cleanText = cleanText.replace(nestedShoppingMatch[0], "").trim();
      lowerText = cleanText.toLowerCase();
    }
    
    // B. DETERMINAR ACCIÓN PRINCIPAL (Incidencia o Compra)
    let isIncidencia = true;
    if (lowerText.includes("compra") || lowerText.includes("comprar") || lowerText.includes("lista")) {
      const hasIncidenciaKeywords = lowerText.includes("incidencia") || lowerText.includes("averia") || 
                                    lowerText.includes("avería") || lowerText.includes("roto") || 
                                    lowerText.includes("rota") || lowerText.includes("fuga") || 
                                    lowerText.includes("olivo") || lowerText.includes("almendro");
      if (!hasIncidenciaKeywords) {
        isIncidencia = false;
      }
    }
    
    let resultMessage = '';
    
    if (isIncidencia) {
      const parsed = parseIncidentVoiceCommand(cleanText, groupData.fincas, null, groupData.selectedFincaId);
      
      // E. DETERMINAR COORDENADAS
      let finalLat = null;
      let finalLng = null;
      if (!parsed.isGeneral || lat) {
        if (lat && lng) {
          finalLat = parseFloat(lat);
          finalLng = parseFloat(lng);
        } else {
          const fincaObj = groupData.fincas.find(f => f.id === parsed.fincaId);
          if (fincaObj) {
            finalLat = fincaObj.lat;
            finalLng = fincaObj.lng;
          }
        }
      }
      
      const newInc = {
        id: 'inc-' + Date.now(),
        fincaId: parsed.fincaId,
        tipo: parsed.tipo,
        descripcion: parsed.descripcion,
        materiales: parsed.materiales,
        herramientas: '',
        lat: finalLat,
        lng: finalLng,
        estado: 'Pendiente',
        fecha: new Date().toISOString()
      };
      
      if (!groupData.incidencias) groupData.incidencias = [];
      groupData.incidencias.push(newInc);
      groupData.lastUpdated = Date.now();
      
      await client.query(`
        UPDATE sync_groups 
        SET data = $1, last_updated = $2
        WHERE code = $3
      `, [JSON.stringify(groupData), groupData.lastUpdated, code]);
      
      const fincaObj = groupData.fincas.find(f => f.id === parsed.fincaId);
      resultMessage = `Incidencia de "${parsed.tipo}" registrada con éxito para la finca ${fincaObj ? fincaObj.name : 'General'}.`;
      if (nestedShoppingItem) {
        resultMessage += ` Y añadido ${nestedShoppingItem} a la lista de la compra.`;
      }
      
    } else {
      // PROCESAR COMPRA
      const items = extractShoppingItems(cleanText);
      if (!groupData.shoppingList) groupData.shoppingList = [];
      
      items.forEach((itemText, idx) => {
        groupData.shoppingList.push({
          id: 'compra-' + Date.now() + '-' + idx,
          text: itemText,
          checked: false
        });
      });
      
      groupData.lastUpdated = Date.now();
      
      await client.query(`
        UPDATE sync_groups 
        SET data = $1, last_updated = $2
        WHERE code = $3
      `, [JSON.stringify(groupData), groupData.lastUpdated, code]);
      
      resultMessage = `Añadidos ${items.length} artículos a la lista de la compra con éxito.`;
    }
    
    return res.json({ success: true, message: resultMessage });
    
  } catch (err) {
    console.error("Database error in voice command endpoint:", err);
    return res.status(500).json({ error: err.message });
  } finally {
    await client.end();
  }
});

// Cualquier otra ruta sirve el index.html principal
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, () => {
  console.log(`Servidor Fincas al Día corriendo en el puerto ${port}`);
});
