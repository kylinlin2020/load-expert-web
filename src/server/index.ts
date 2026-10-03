/**
 * 服务层启动入口：默认监听 3000 端口
 * 通过 PORT 环境变量可覆盖端口
 */
import { buildApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);
const app = buildApp();

const start = async (): Promise<void> => {
  try {
    await app.listen({ port, host: '0.0.0.0' });
    app.log.info(`LoadExpert API listening on http://0.0.0.0:${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

void start();
