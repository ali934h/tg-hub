module.exports = {
  apps: [
    {
      name: "tg-hub",
      script: "src/index.js",
      watch: false,
      restart_delay: 5000,
      max_restarts: 10,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
