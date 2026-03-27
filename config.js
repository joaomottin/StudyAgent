const dotenv = require('dotenv');

dotenv.config();

module.exports = {
  PORT: Number(process.env.PORT || 3000),
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  GEMINI_MAX_PDF_INLINE_BYTES: Number(process.env.GEMINI_MAX_PDF_INLINE_BYTES || 4500000),
  GEMINI_CACHE_TTL_SECONDS: Number(process.env.GEMINI_CACHE_TTL_SECONDS || 86400),
};
