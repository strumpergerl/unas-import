module.exports = {
  apps: [
    {
      name: 'unas-importer',
      script: 'npm',
      args: 'start',
      cwd: __dirname,      // munkakönyvtár a projekt gyökere
      watch: true,
      env: {
        NODE_ENV: 'development'
      },
      env_production: {
        NODE_ENV: 'production',
        SUPPLIER_FILE_URL: process.env.SUPPLIER_FILE_URL,
        UNAS_API_URL: process.env.UNAS_API_URL,
        UNAS_API_KEY: process.env.UNAS_API_KEY,
        MARGIN_PERCENTAGE: process.env.MARGIN_PERCENTAGE,
        EMAIL_HOST: process.env.EMAIL_HOST,
        EMAIL_PORT: process.env.EMAIL_PORT,
        EMAIL_USER: process.env.EMAIL_USER,
        EMAIL_PASS: process.env.EMAIL_PASS,
        EMAIL_TO: process.env.EMAIL_TO
      }
    }
  ]
};