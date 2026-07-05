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
    
    const cleanText = text.trim();
    const lowerText = cleanText.toLowerCase();
    
    // 1. DETERMINAR ACCIÓN (Incidencia o Compra)
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
      // A. DETECTAR FINCA
      let fincaId = groupData.selectedFincaId || (groupData.fincas[0] ? groupData.fincas[0].id : 'general');
      if (groupData.fincas && groupData.fincas.length > 0) {
        for (const finca of groupData.fincas) {
          if (finca.name && lowerText.includes(finca.name.toLowerCase())) {
            fincaId = finca.id;
            break;
          }
        }
      }
      
      // B. DETECTAR SI ES LOCALIZADA (GPS) O GENERAL
      let isGeneral = true;
      const gpsKeywords = ["donde estoy", "dónde estoy", "aqui", "aquí", "ubicacion actual", "ubicación actual", "mi posicion", "mi posición", "gps"];
      if (gpsKeywords.some(keyword => lowerText.includes(keyword)) || lat) {
        isGeneral = false;
      }
      
      // C. EXTRACT MATERIALES (necesito X)
      let materiales = '';
      const necesitoRegex = /(?:necesito|necesitamos|hace falta|hacen falta|hace falta comprar|comprar)\s+([^,.]+)/i;
      const necesitoMatch = cleanText.match(necesitoRegex);
      if (necesitoMatch && necesitoMatch[1]) {
        materiales = necesitoMatch[1].trim();
        materiales = materiales.replace(/^(un|una|unos|unas|el|la|los|las|algun|algunos|algunas)\s+/i, '');
        materiales = materiales.charAt(0).toUpperCase() + materiales.slice(1);
      }
      
      // D. EXTRACT TIPO DE INCIDENCIA
      let tipo = '';
      const hayRegex = /(?:hay|tengo|se ha detectado|detectado|veo)\s+(?:un\s+|una\s+)?([^,.]+?(?:roto|rota|enfermo|enferma|dañado|dañada|fuga|perdida|perdiendo|roto|rota))/i;
      const hayMatch = cleanText.match(hayRegex);
      if (hayMatch && hayMatch[1]) {
        tipo = hayMatch[1].trim();
      } else {
        const startMatch = cleanText.match(/(?:incidencia|averia|avería|reportar)\s+(?:donde estoy\s+)?(?:hay\s+)?([^,.]+?)(?:\s+(?:necesito|para|donde|en|de)\b|$)/i);
        if (startMatch && startMatch[1]) {
          tipo = startMatch[1].trim();
        }
      }
      
      if (tipo) {
        tipo = tipo.replace(/^(un|una|unos|unas|el|la|los|las)\s+/i, '');
        tipo = tipo.charAt(0).toUpperCase() + tipo.slice(1);
      } else {
        tipo = "Incidencia de Voz";
      }
      
      // E. DETERMINAR COORDENADAS
      let finalLat = null;
      let finalLng = null;
      if (!isGeneral) {
        if (lat && lng) {
          finalLat = parseFloat(lat);
          finalLng = parseFloat(lng);
        } else {
          // Intentar finca
          const fincaObj = groupData.fincas.find(f => f.id === fincaId);
          if (fincaObj) {
            finalLat = fincaObj.lat;
            finalLng = fincaObj.lng;
          }
        }
      }
      
      const newInc = {
        id: 'inc-' + Date.now(),
        fincaId: fincaId,
        tipo: tipo,
        descripcion: cleanText,
        materiales: materiales,
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
      
      const fincaObj = groupData.fincas.find(f => f.id === fincaId);
      resultMessage = `Incidencia de "${tipo}" registrada con éxito para la finca ${fincaObj ? fincaObj.name : 'General'}.`;
      
    } else {
      // PROCESAR COMPRA
      let cleanPhrase = cleanText.replace(/^(comprar|añadir a la lista|lista de la compra|añadir|necesito comprar)\s+/i, '');
      const items = cleanPhrase.split(/\s+y\s+|,/i);
      if (!groupData.shoppingList) groupData.shoppingList = [];
      
      items.forEach((it, idx) => {
        const text = it.trim();
        if (text) {
          const formatted = text.charAt(0).toUpperCase() + text.slice(1);
          groupData.shoppingList.push({
            id: 'compra-' + Date.now() + '-' + idx,
            text: formatted,
            checked: false
          });
        }
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
