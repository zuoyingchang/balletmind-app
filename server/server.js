const app = require('./app');
const { PORT } = require('./config');

app.listen(PORT, () => {
  console.log(`BalletMind server running at http://localhost:${PORT}`);
});
