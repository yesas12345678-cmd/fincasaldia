const { Client } = require('pg');

const connectionString = 'postgresql://postgres:vd1tmp242irvcww1@187.127.233.89:5438/postgres';

async function test() {
  const client = new Client({
    connectionString,
    ssl: false
  });
  
  try {
    await client.connect();
    console.log("¡Conexión a PostgreSQL establecida con éxito!");
    
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS sync_groups (
        code VARCHAR(50) PRIMARY KEY,
        data JSONB NOT NULL,
        last_updated BIGINT NOT NULL DEFAULT 0
      );
    `;
    await client.query(createTableQuery);
    console.log("Tabla 'sync_groups' verificada/creada.");
    
    const testData = {
      fincas: [],
      incidencias: [],
      folders: [],
      lastUpdated: Date.now()
    };
    
    const insertQuery = `
      INSERT INTO sync_groups (code, data, last_updated)
      VALUES ($1, $2, $3)
      ON CONFLICT (code)
      DO UPDATE SET data = EXCLUDED.data, last_updated = EXCLUDED.last_updated
      RETURNING *;
    `;
    const res = await client.query(insertQuery, ['testgroup', JSON.stringify(testData), testData.lastUpdated]);
    console.log("Fila de prueba insertada/actualizada con éxito:", res.rows[0]);
    
  } catch (err) {
    console.error("Error en la base de datos:", err);
  } finally {
    await client.end();
  }
}

test();
