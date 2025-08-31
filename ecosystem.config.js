module.exports = {
  apps: [
    {
      name: 'unas-importer',
      script: 'npm',
      args: 'start',
      cwd: __dirname,
      watch: true,
      env: {
        NODE_ENV: 'development'
      },
      env_production: {
        NODE_ENV: 'production'
      }
    }
  ]
};