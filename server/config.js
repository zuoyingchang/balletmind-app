require('dotenv').config();

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error('缺少 JWT_SECRET，请在 .env 里配置（用于登录令牌签名）');
  process.exit(1);
}

module.exports = { PORT, JWT_SECRET };
