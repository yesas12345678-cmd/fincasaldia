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

// Cualquier otra ruta sirve el index.html principal
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, () => {
  console.log(`Servidor Fincas al Día corriendo en el puerto ${port}`);
});
