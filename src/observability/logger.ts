import pino from "pino";

export type Logger = pino.Logger;

export function createLogger(level: string): Logger {
  return pino({
    level,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "headers.authorization",
        "headers.cookie",
        "authorization",
        "cookie",
        "accessToken",
        "token",
      ],
      censor: "[REDACTED]",
    },
  });
}
