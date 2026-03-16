type LogContext = Record<string, unknown> | undefined;

function write(method: "debug" | "info" | "warn" | "error", message: string, context?: LogContext): void {
  if (context && Object.keys(context).length > 0) {
    console[method](message, context);
    return;
  }

  console[method](message);
}

export class Logger {
  static debug(message: string, context?: LogContext): void {
    write("debug", message, context);
  }

  static info(message: string, context?: LogContext): void {
    write("info", message, context);
  }

  static warn(message: string, context?: LogContext): void {
    write("warn", message, context);
  }

  static error(message: string, context?: LogContext): void {
    write("error", message, context);
  }
}
