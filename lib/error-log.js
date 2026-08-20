import { writeFileSync } from "fs";

/**
 * Per-run error log (overwritten each run; accumulates errors within one run).
 * @param {string} errorLogFile
 */
export function createRunErrorLogger(errorLogFile) {
  const runErrors = [];
  let initialized = false;

  return {
    get initialized() {
      return initialized;
    },

    init() {
      runErrors.length = 0;
      initialized = true;
      try {
        writeFileSync(errorLogFile, "", "utf-8");
      } catch (error) {
        console.warn(`⚠️  Could not initialize error log (${errorLogFile}):`, error.message);
      }
    },

    /**
     * @param {string} message
     * @param {Error | unknown} [error]
     */
    record(message, error) {
      const timestamp = new Date().toLocaleString();
      let entry = `[${timestamp}] ${message}`;
      if (error instanceof Error) {
        entry += `\n${error.message}`;
        if (error.stack) {
          entry += `\n${error.stack}`;
        }
      } else if (error !== undefined && error !== null) {
        entry += `\n${String(error)}`;
      }
      runErrors.push(entry);
      try {
        writeFileSync(errorLogFile, `${runErrors.join("\n\n")}\n`, "utf-8");
      } catch (writeError) {
        console.warn(`⚠️  Could not write error log (${errorLogFile}):`, writeError.message);
      }
    },
  };
}
