const express = require('express');
const path = require('path');
const api = require('./api');

const app = express();
const PORT = process.env.PORT || 3000;

// REST API
app.use('/api', api);

// Statikus frontend kiszolgálása
const staticPath = path.join(__dirname, '../public');
app.use(express.static(staticPath));
app.get('*', (req, res) => {
  res.sendFile(path.join(staticPath, 'index.html'));
});

app.listen(PORT, () => console.log(`Server fut a ${PORT}-on`));