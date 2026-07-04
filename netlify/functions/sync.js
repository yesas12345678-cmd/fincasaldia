// netlify/functions/sync.js
// Función Serverless para sincronizar fincas e incidencias en la base de datos PostgreSQL del usuario

const { Client } = require('pg');
const connectionString = 'postgresql://postgres:vd1tmp242irvcww1@187.127.233.89:5438/postgres';

exports.handler = async function(event, context) {
  const code = event.queryStringParameters && event.queryStringParameters.code;
  const action = event.queryStringParameters && event.queryStringParameters.action;
  
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json"
  };

  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers
    };
  }

  const client = new Client({
    connectionString,
    ssl: false
  });

  try {
    await client.connect();
    
    // Asegurar que la tabla existe en la base de datos
    await client.query(`
      CREATE TABLE IF NOT EXISTS sync_groups (
        code VARCHAR(50) PRIMARY KEY,
        data JSONB NOT NULL,
        last_updated BIGINT NOT NULL DEFAULT 0
      );
    `);

    // 1. LISTAR CUENTAS (Solo para el administrador con contraseña)
    if (action === 'list') {
      const password = event.queryStringParameters.password;
      if (password !== 'Manuel1214$') {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ error: "Unauthorized" })
        };
      }
      const res = await client.query('SELECT code, last_updated FROM sync_groups ORDER BY code ASC');
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(res.rows)
      };
    }

    // 2. CREACIÓN DE GRUPO NUEVO DESDE EL CLIENTE (POST sin código)
    if (!code && event.httpMethod === "POST") {
      const payload = JSON.parse(event.body);
      
      // Generar un código único de 7 caracteres alfanuméricos
      let uniqueCode = '';
      let exists = true;
      while (exists) {
        uniqueCode = Math.random().toString(36).substring(2, 9).toLowerCase();
        const check = await client.query('SELECT 1 FROM sync_groups WHERE code = $1', [uniqueCode]);
        if (check.rows.length === 0) {
          exists = false;
        }
      }

      // Guardar el estado inicial en el nuevo grupo
      const lastUpdated = payload.lastUpdated || Date.now();
      await client.query(
        'INSERT INTO sync_groups (code, data, last_updated) VALUES ($1, $2, $3)',
        [uniqueCode, JSON.stringify(payload), lastUpdated]
      );

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ id: uniqueCode })
      };
    }

    if (!code) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing code parameter" })
      };
    }

    // 3. OBTENER DATOS (GET con código)
    if (event.httpMethod === "GET") {
      const res = await client.query('SELECT data FROM sync_groups WHERE code = $1', [code]);
      if (res.rows.length > 0) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify(res.rows[0].data)
        };
      } else {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: "Group not found" })
        };
      }
    }

    // 4. ACTUALIZAR DATOS (POST con código)
    if (event.httpMethod === "POST") {
      const payload = JSON.parse(event.body);
      const lastUpdated = payload.lastUpdated || Date.now();
      
      await client.query(`
        INSERT INTO sync_groups (code, data, last_updated)
        VALUES ($1, $2, $3)
        ON CONFLICT (code)
        DO UPDATE SET data = EXCLUDED.data, last_updated = EXCLUDED.last_updated
      `, [code, JSON.stringify(payload), lastUpdated]);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true })
      };
    }

    return {
      statusCode: 405,
      headers,
      body: "Method Not Allowed"
    };

  } catch (err) {
    console.error("Database error in Netlify Function:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  } finally {
    await client.end();
  }
};
