const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9090;
const DIR = __dirname;

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
};

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // PUT fleet.json — save updates
  if (req.method === 'PUT' && req.url.startsWith('/fleet.json')) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        JSON.parse(body); // validate
        fs.writeFileSync(path.join(DIR, 'fleet.json'), body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(`{"error":"${e.message}"}`);
      }
    });
    return;
  }

  // GET — serve static files
  let filePath = path.join(DIR, req.url.split('?')[0]);
  if (filePath.endsWith('/')) filePath += 'index.html';

  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Spyglass Portal running on http://0.0.0.0:${PORT}`);
});
