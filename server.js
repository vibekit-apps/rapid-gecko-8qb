
const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  try {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  } catch (e) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body style="background:#0a0a0f;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh"><h1>Setting up...</h1></body></html>');
  }
}).listen(PORT, () => console.log('Placeholder ready on port ' + PORT));
