import { createApp } from './app.js';
import { loadEnv } from './env.js';

loadEnv();
const port = Number(process.env.PORT || 8787);
const { app } = createApp();
app.listen(port, '127.0.0.1', () => {
  console.log(`FitCalorie listening on http://127.0.0.1:${port}`);
});
