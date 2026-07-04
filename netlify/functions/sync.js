// netlify/functions/sync.js
// Función Serverless para evitar CORS preflight OPTIONS en el navegador al usar ExtendsClass

exports.handler = async function(event, context) {
  const code = event.queryStringParameters && event.queryStringParameters.code;
  
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

  // Si no hay código de grupo, significa que se quiere CREAR un nuevo grupo
  if (!code) {
    if (event.httpMethod === "POST") {
      try {
        const res = await fetch('https://extendsclass.com/api/json-storage/bin', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: event.body
        });
        if (!res.ok) {
          const errText = await res.text();
          return {
            statusCode: res.status,
            headers,
            body: JSON.stringify({ error: errText })
          };
        }
        const data = await res.json();
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify(data)
        };
      } catch (err) {
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({ error: err.message })
        };
      }
    }
    
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Missing code parameter" })
    };
  }

  const url = `https://extendsclass.com/api/json-storage/bin/${code}`;

  if (event.httpMethod === "GET") {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        return {
          statusCode: res.status,
          headers,
          body: await res.text()
        };
      }
      const data = await res.json();
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(data)
      };
    } catch (err) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: err.message })
      };
    }
  }

  if (event.httpMethod === "POST") {
    try {
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: event.body
      });
      if (!res.ok) {
        const errText = await res.text();
        return {
          statusCode: res.status,
          headers,
          body: JSON.stringify({ error: errText })
        };
      }
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true })
      };
    } catch (err) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: err.message })
      };
    }
  }

  return {
    statusCode: 405,
    headers,
    body: "Method Not Allowed"
  };
};
