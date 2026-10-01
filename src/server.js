'use strict';

const { createApp } = require('./app');
const { PORT, HOST } = require('./config');

const app = createApp();

app.listen(PORT, HOST, () => {
  console.log(`字幕校订服务已启动: http://${HOST}:${PORT}`);
});
