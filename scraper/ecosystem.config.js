/**
 * PM2 ecosystem file for FidesBot Scanner.
 * Usage on VPS:
 *   pm2 start ecosystem.config.js
 *   pm2 save && pm2 startup   ← auto-restart on reboot
 *   pm2 logs fidesbot-scanner  ← see logs
 *   pm2 restart fidesbot-scanner
 */

module.exports = {
  apps: [
    {
      name: "fidesbot-scanner",
      script: "dist/index.js",
      // Restart automatically if it crashes
      autorestart: true,
      watch: false,
      // Restart if memory exceeds 512MB (Playwright can be heavy)
      max_memory_restart: "512M",
      // Load environment variables from .env file
      env_file: ".env",
      env: {
        NODE_ENV: "production",
      },
      // Log rotation
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: "logs/error.log",
      out_file: "logs/out.log",
      merge_logs: true,
    },
  ],
};
