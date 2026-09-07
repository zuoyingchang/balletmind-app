const app = require('./app');
const { PORT } = require('./config');
const db = require('./db');

db.ready
  .then(() => {
    app.listen(PORT, () => {
      console.log(`BalletMind server running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('数据库初始化失败', err);
    process.exit(1);
  });
