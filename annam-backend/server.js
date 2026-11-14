const { app, startTimers } = require('./app');
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  startTimers();
  console.log(`Annam backend running at http://localhost:${PORT}  (API under /api, static front end from /public)`);
});
