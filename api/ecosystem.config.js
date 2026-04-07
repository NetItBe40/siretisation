module.exports = {
  apps: [{
    name: 'siretisation-api',
    script: 'server.js',
    cwd: '/home/netit972/sirene-etl/api',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production',
      PORT: 3001
    },
    error_file: '/home/netit972/sirene-etl/api/logs/pm2-error.log',
    out_file: '/home/netit972/sirene-etl/api/logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true
  }]
};
