import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: process.env.NODE_ENV !== 'production' ? {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'SYS:standard' }
  } : undefined,
  base: { pid: process.pid, service: 'jarvis-voice' },
});

export default logger;
