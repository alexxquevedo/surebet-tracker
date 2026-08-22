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
      autorestart: true,
      watch: false,
      // Restart if memory exceeds 512MB (Playwright can be heavy)
      max_memory_restart: "512M",
      env_file: ".env",
      env: { NODE_ENV: "production" },
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: "logs/error.log",
      out_file: "logs/out.log",
      merge_logs: true,
    },
    {
      // Relay SOCKS5 hacia el router Cudy LT500 vía WireGuard.
      // microsocks escucha en el router (10.8.0.2:1080); este proceso verifica
      // la conectividad cada 60s y registra la IP de salida.
      //
      // Arrancar SOLO después de que el router esté conectado por WireGuard:
      //   pm2 start ecosystem.config.js --only proxy-relay
      //
      // Verificación manual:
      //   curl --proxy socks5h://10.8.0.2:1080 https://api.ipify.org
      name: "proxy-relay",
      script: "scripts/proxy_health.sh",
      interpreter: "bash",
      autorestart: true,
      watch: false,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: "logs/proxy-relay-error.log",
      out_file: "logs/proxy-relay-out.log",
      merge_logs: true,
      // No arrancar automáticamente — sólo cuando el router esté activo
      // Cambiar a true una vez configurado el Cudy LT500
      stop_exit_codes: [0],
    },
  ],
};
